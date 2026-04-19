# Auto-archive Notification URLs (Implementation Plan)

## 1. Goal

Whenever wachi successfully sends a notification through any apprise channel
(Discord, Slack, Telegram, …), submit the **link contained in that
notification** to the Internet Archive's Wayback Machine for permanent
preservation.

The feature must be:

- **On by default** — zero config required for the common case
- **Toggleable via env var** — `WACHI_NO_ARCHIVE=1` disables it completely
- **Performance-neutral** — never blocks or slows down the existing
  `wachi check` flow
- **Stateless** — no new database tables or schema migrations
- **Resilient** — archive failures must NEVER fail a notification or affect
  exit codes

## 2. Design Principles

1. **Notification path is sacred.** A notification is considered successful the
   moment `sendNotification()` returns. Archive submission happens *after* and
   on a separate logical track.
2. **Fire-and-forget submission.** SPN2's POST endpoint returns a `job_id`
   within ~1–3 seconds and finishes the actual capture asynchronously on
   archive.org's side. We submit and forget — we do **not** poll
   `/save/status/<job_id>`.
3. **Stateless dedup.** Instead of a local `archives` table, rely on SPN2's
   `if_not_archived_within=<window>` parameter. Wayback returns the existing
   snapshot if a recent capture exists, costing us nothing.
4. **Bounded concurrency, bounded lifetime.** A small in-memory pool tracks
   in-flight submissions so the process can wait briefly before exiting,
   without ever blocking the next notification.
5. **Silent by default, observable in verbose mode.** Use the existing
   `[verbose]` / `printStderr` convention. Never use `console.*`.

## 3. Configuration (env vars)

Add three env vars to `src/utils/env.ts`:

| Var | Type | Default | Purpose |
|---|---|---|---|
| `WACHI_NO_ARCHIVE` | `"1"` to disable | unset (= enabled) | Master kill switch |
| `WACHI_ARCHIVE_ACCESS_KEY` | string | unset | Internet Archive S3 access key |
| `WACHI_ARCHIVE_SECRET_KEY` | string | unset | Internet Archive S3 secret key |

### Behavior matrix

| `NO_ARCHIVE` | Keys present? | Result |
|---|---|---|
| unset | both present | **Authenticated POST** (12 concurrent, 100k/day) |
| unset | one or neither | **Anonymous GET fallback** (6 concurrent, 4k/day) + one-time stderr hint |
| `=1` | n/a | **Disabled**, no calls made |

> Rationale: keys are *recommended* for the higher quota and POST-only
> options, but the feature still works zero-config so the user gets value
> immediately. The user has stated they will issue keys later.

### Naming consistency

Follows the existing `WACHI_NO_AUTO_UPDATE` precedent:
- Uppercase `WACHI_*` prefix
- Negative flag (`NO_*`) for disable
- String `"1"` literal comparison (`=== "1"`)

### Updated `src/utils/env.ts`

```ts
export const getEnv = () => {
  return {
    appriseUrlOverride: readEnv("WACHI_APPRISE_URL"),
    configPath: readEnv("WACHI_CONFIG_PATH"),
    dbPath: readEnv("WACHI_DB_PATH"),
    pathsRoot: readEnv("WACHI_PATHS_ROOT"),
    wrapperPath: readEnv("WACHI_WRAPPER_PATH"),
    noAutoUpdate: readEnv("WACHI_NO_AUTO_UPDATE") === "1",
    // NEW
    noArchive: readEnv("WACHI_NO_ARCHIVE") === "1",
    archiveAccessKey: readEnv("WACHI_ARCHIVE_ACCESS_KEY"),
    archiveSecretKey: readEnv("WACHI_ARCHIVE_SECRET_KEY"),
  };
};
```

## 4. Architecture

### New module: `src/lib/archive/`

```
src/lib/archive/
├── client.ts        # Wayback SPN2 HTTP client (POST / GET fallback)
├── submit.ts        # Public entry: submitArchive(link, options)
├── pool.ts          # In-flight submission tracker + flush()
└── url-policy.ts    # Decides whether a URL should be archived
```

#### `url-policy.ts` — `shouldArchive(url): boolean`

Skip URLs that don't make sense to archive:

- Non-`http(s)` schemes (`mailto:`, `magnet:`, `ftp:`, …)
- Loopback / RFC1918 / `.local` hosts
- Already-archived URLs (`web.archive.org/*`, `archive.ph/*`, `archive.today/*`)

Returns `true` for everything else. This is a pure function — easy to unit test.

#### `client.ts` — Wayback SPN2 wrapper

Two functions:

```ts
// Authenticated path — preferred
export const submitWaybackPost = async (
  url: string,
  opts: { accessKey: string; secretKey: string; signal?: AbortSignal },
): Promise<{ jobId: string }> => {
  const res = await http("https://web.archive.org/save", {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `LOW ${opts.accessKey}:${opts.secretKey}`,
    },
    body: new URLSearchParams({
      url,
      // SPN2 speed/cost optimizations (see Wayback SPN2 docs):
      skip_first_archive: "1",        // skip "is this the first capture?" check
      if_not_archived_within: "30d",  // server-side dedup, return existing snapshot
      delay_wb_availability: "1",     // 12h-deferred indexing -> reduces IA load
    }),
    timeout: 10_000,
    retry: 0, // we'll handle our own retry policy (none, by design)
    signal: opts.signal,
  });
  return { jobId: res.job_id };
};

// Anonymous fallback — when no keys configured
export const submitWaybackGet = async (
  url: string,
  opts: { signal?: AbortSignal },
): Promise<void> => {
  // Just kick the GET endpoint; the response is a redirect to the snapshot.
  // We discard the body. Anonymous mode does NOT return a job_id.
  await http(`https://web.archive.org/save/${url}`, {
    method: "GET",
    redirect: "manual",
    timeout: 10_000,
    retry: 0,
    signal: opts.signal,
  });
};
```

Reuse the existing `http` client from `src/lib/http/client.ts` (already has
`User-Agent: wachi/<VERSION>`).

#### `pool.ts` — bounded background tracking

```ts
const MAX_CONCURRENT = 6;        // matches anonymous SPN2 limit
const FLUSH_TIMEOUT_MS = 15_000; // grace period before process exit

const inflight = new Set<Promise<void>>();
let acquired = 0;

export const trackArchive = (task: () => Promise<void>): void => {
  if (acquired >= MAX_CONCURRENT) {
    // Drop submission if we're saturated. Wayback rate-limits at 15/min
    // anyway, and we MUST NOT block the notification path.
    return;
  }
  acquired += 1;
  const p = task().finally(() => {
    acquired -= 1;
    inflight.delete(p);
  });
  inflight.add(p);
};

export const flushArchivePool = async (
  timeoutMs = FLUSH_TIMEOUT_MS,
): Promise<void> => {
  if (inflight.size === 0) return;
  const all = Promise.allSettled(inflight);
  const timer = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  await Promise.race([all, timer]);
};

export const resetArchivePoolForTest = (): void => {
  inflight.clear();
  acquired = 0;
};
```

#### `submit.ts` — public entry

```ts
import { getEnv } from "../../utils/env.ts";
import { printStderr } from "../cli/io.ts";
import { submitWaybackGet, submitWaybackPost } from "./client.ts";
import { trackArchive } from "./pool.ts";
import { shouldArchive } from "./url-policy.ts";

let hintShown = false;

export const submitArchive = (
  link: string,
  opts: { isVerbose?: boolean } = {},
): void => {
  const env = getEnv();
  if (env.noArchive) return;
  if (!shouldArchive(link)) return;

  const hasKeys = Boolean(env.archiveAccessKey && env.archiveSecretKey);

  if (!hasKeys && !hintShown) {
    hintShown = true;
    printStderr(
      "[verbose] archive: using anonymous Wayback API (set WACHI_ARCHIVE_ACCESS_KEY / _SECRET_KEY for higher limits)",
    );
  }

  trackArchive(async () => {
    try {
      if (hasKeys) {
        await submitWaybackPost(link, {
          accessKey: env.archiveAccessKey!,
          secretKey: env.archiveSecretKey!,
        });
      } else {
        await submitWaybackGet(link, {});
      }
      if (opts.isVerbose) {
        printStderr(`[verbose] archive: submitted ${link}`);
      }
    } catch (error) {
      if (opts.isVerbose) {
        const reason = error instanceof Error ? error.message : "unknown error";
        printStderr(`[verbose] archive: failed for ${link} (${reason})`);
      }
      // Swallow — archive failure must never affect the main flow.
    }
  });
};

export const resetArchiveSubmitStateForTest = (): void => {
  hintShown = false;
};
```

### Wiring into `handle-items.ts`

A single new line right after the notification succeeds. The submission is
synchronous-looking but trackArchive returns immediately — actual work is
backgrounded.

```diff
// src/lib/check/handle-items.ts (around line 116-126)
       try {
         await enqueueForChannel(effectiveChannelUrl, async () => {
           await sendNotification({
             appriseUrl: effectiveChannelUrl,
             body,
             sourceIdentity: itemSourceIdentity,
           });
         });
+        // Fire-and-forget: archive the notified link. Never blocks.
+        submitArchive(item.link, { isVerbose });
         pushSent(stats, item, channelName);
         if (!isJson) {
           printStdout(`sent: ${item.title} -> ${channelName}`);
         }
```

**Important details:**

- Use `notificationLink` for `x.com` / `twitter.com` items because Wayback
  rejects direct archiving of those original URLs with `error:blocked-url`.
- Use `item.link` (the **original** RSS link) for everything else so archive
  behavior stays stable even if unrelated `link_transforms` settings change.
- Skip in `dryRun` — the diff above is in the non-dry-run branch only.
- Skip on `sendNotification` failure — the diff above is inside `try {}` and
  only after `enqueueForChannel` resolves.
- Skip in `wachi test` — that path uses a synthetic `TEST_BODY` with no
  real link to archive (no change needed; `submitArchive` is not called from
  `commands/test.ts`).
- Skip in failure-alert path (`handle-failure.ts`) — meta-notifications about
  feed failures contain no archivable URL of interest.

### Wiring into `run-check.ts`

Add a single `flushArchivePool()` call at the end of `runCheck()`, just
before it returns. This gives in-flight POSTs up to 15s to finish handing off
to Wayback, but never longer.

```diff
// src/lib/check/run-check.ts (end of runCheck)
   // ... existing logic ...
+  await flushArchivePool();
   return result;
```

## 5. Data Flow

```
wachi check
  ↓
runCheck()  ──── for each subscription ────┐
                                            ↓
                              checkRssSubscription()
                                            ↓
                              handleSubscriptionItems()
                                            ↓
                       per item: insertDedupRecord()
                                            ↓
                              sendNotification()  ◄── existing path, untouched
                                            ↓                        │
                       ┌────────────────────┴────────────────────┐  │
                       │ (success)                                │  │
                       ↓                                          ↓  │
              pushSent() / printStdout()              submitArchive(item.link)
                                                                 │
                                                                 ↓
                                                       trackArchive(task)
                                                                 │
                                                  (returns immediately)
                                                                 ↓
                                              [background] POST web.archive.org/save
                                                                 │
                                                                 ↓
                                                  swallow result / log if verbose
  ↓
flushArchivePool(15s timeout)  ◄── waits for in-flight submissions
  ↓
process exits
```

## 6. Edge Cases & Error Handling

| Case | Behavior |
|---|---|
| `WACHI_NO_ARCHIVE=1` | `submitArchive()` returns immediately, no HTTP call |
| Keys missing | Use anonymous GET; print one-time `[verbose]` hint |
| `item.link` is a `mailto:` / non-http URL | `shouldArchive()` returns false, skip |
| `item.link` is already a `web.archive.org/*` URL | Skip (avoid recursion) |
| Wayback returns 429 (rate limited) | Caught silently; no retry |
| Wayback returns 5xx | Caught silently; no retry |
| Network unreachable | Caught silently; no retry |
| User invokes Ctrl+C | `flushArchivePool` resolves on its 15s timer at worst |
| Pool saturated (>6 in-flight) | New submissions dropped silently |
| `dry-run` mode | Not called (guarded by branch in `handle-items.ts`) |
| `wachi test` | Not called (different code path) |
| Send fails after archive enqueued | Archive still proceeds — it's already a successful notification from Wayback's perspective. Acceptable. |

## 7. Performance Considerations

| Concern | Mitigation |
|---|---|
| Blocking the per-channel queue | `submitArchive` returns synchronously after `trackArchive`; the channel queue's awaited task already finished. |
| Slowing down `wachi check` exit | `flushArchivePool` has a hard 15s ceiling. Typical case: 1–3s per POST × concurrent ≤ 6. |
| Memory growth on huge feeds | Pool capped at `MAX_CONCURRENT = 6`. Excess submissions are **dropped**, not queued — by design. |
| Hitting Wayback's 15 req/min IP limit | The `MAX_CONCURRENT = 6` + per-host serialization in `http/rate-limit.ts` (already in use by `http`) keeps us safely below. |
| Re-archiving the same URL repeatedly | `if_not_archived_within=30d` makes Wayback return the existing snapshot for free. |
| Cold start cost | First call is just an HTTP POST through the existing `ofetch` client — no setup. |

Worst-case added latency on `wachi check`: **+15s at exit** if a batch of
slow archive submissions is in flight. Typical case: **+0s** (most
submissions return their `job_id` in 1–3s, well within the timeout).

Per-notification latency added: **0ms** (truly fire-and-forget).

## 8. Testing Strategy

### Unit tests

- `test/unit/lib/archive/url-policy.test.ts`
  - `shouldArchive("https://example.com")` → `true`
  - `shouldArchive("mailto:a@b")` → `false`
  - `shouldArchive("https://web.archive.org/web/.../https://x.com")` → `false`
  - `shouldArchive("http://192.168.0.1")` → `false`
  - `shouldArchive("https://archive.ph/abc")` → `false`

- `test/unit/lib/archive/client.test.ts`
  - Mock `http`. Verify `submitWaybackPost` sends correct `Authorization`
    header, body params (`skip_first_archive=1`, `if_not_archived_within=30d`,
    `delay_wb_availability=1`), and parses `job_id`.
  - Verify `submitWaybackGet` calls the right URL and does not set auth.
  - Both must pass through `signal` for cancellation.

- `test/unit/lib/archive/pool.test.ts`
  - `trackArchive` enqueues up to `MAX_CONCURRENT`, drops the rest.
  - `flushArchivePool` resolves when all complete.
  - `flushArchivePool` resolves on timeout even if tasks hang.
  - Pool is correctly drained on task rejection.

- `test/unit/lib/archive/submit.test.ts`
  - `WACHI_NO_ARCHIVE=1` → no work scheduled.
  - Keys present → POST path used.
  - Keys absent → GET path used + hint printed exactly once across calls.
  - Network error → silent (no throw), verbose mode logs to stderr.

- `test/unit/utils/env.test.ts` (extend)
  - Resolution of `noArchive`, `archiveAccessKey`, `archiveSecretKey`.

### Integration tests

- `test/integration/handle-items-archive.test.ts`
  - Mock `submitArchive`. Verify it is called with `item.link` (original,
    not transformed) when a notification succeeds.
  - Verify it is **not** called in `dryRun: true` mode.
  - Verify it is **not** called when `sendNotification` throws.

### E2E tests

- `test/e2e/archive-disabled.test.ts`
  - Spawn `wachi check` with `WACHI_NO_ARCHIVE=1`.
  - Assert no outbound request to `web.archive.org` (use a process-level
    fetch interceptor or a local mock server bound via env).

- `test/e2e/archive-enabled.test.ts`
  - Spawn `wachi check` against a mock SPN2 server that records hits.
  - Assert one POST per delivered notification, with the original link in
    the body.

### Test infrastructure additions

- A small `mockWaybackServer.ts` test helper that listens on an ephemeral
  port and records requests (similar to existing fixtures).
- The mock URL is injected via a hidden `WACHI_ARCHIVE_ENDPOINT_OVERRIDE`
  env var read by `client.ts` (test-only; not documented for users).

## 9. Implementation Steps (in order)

1. **Env vars** — add `noArchive`, `archiveAccessKey`, `archiveSecretKey`
   to `src/utils/env.ts`. Update `test/unit/utils/env.test.ts`.
2. **URL policy** — write `src/lib/archive/url-policy.ts` + unit tests.
3. **HTTP client** — write `src/lib/archive/client.ts` (POST + GET) + unit
   tests with mocked `http`.
4. **Pool** — write `src/lib/archive/pool.ts` + unit tests, including the
   timeout case.
5. **Public entry** — write `src/lib/archive/submit.ts` + unit tests
   (env switching, hint behavior, error swallowing).
6. **Wire into handle-items** — single-line addition after the successful
   `enqueueForChannel` await. Add integration test.
7. **Wire into run-check** — single-line `await flushArchivePool()` before
   return. Verify exit timing in e2e.
8. **Mock SPN2 server** — add test helper. Add e2e tests for both env states.
9. **Documentation** — update:
   - `README.md` env var table — add the three new vars
   - `SPEC.md` — add a short "Notification archiving" section under
     notifications, documenting defaults and stateless design
10. **Manual smoke test** — run `wachi check` against a real subscription,
    confirm the link appears at `https://web.archive.org/web/*/<link>` within
    a few minutes (or 12h if `delay_wb_availability=1` is kept — see Open
    Questions).

## 10. Open Questions

1. **Should we keep `delay_wb_availability=1`?**
   - Pro: lighter on Wayback's infra; archive.org explicitly recommends it
     for automated submitters.
   - Con: snapshot only browsable ~12h later. Acceptable for our archival
     use case (we don't need immediate replay), but worth confirming.
   - Recommendation: **keep it on** by default; expose as
     `WACHI_ARCHIVE_FAST=1` to disable if a user has a real-time use case.

2. **Should anonymous GET fallback exist, or should missing keys → disabled?**
   - The user said "default ON". GET fallback honors that even before keys
     are issued. Recommendation: **keep the fallback**, with the one-time
     verbose hint nudging toward keys.

3. **Should `flushArchivePool` timeout be configurable?**
   - Probably not worth a public env var. Keep `15s` constant in code.
   - If users complain about exit latency, expose later.

4. **`if_not_archived_within` window?**
   - 30 days is a reasonable default for an RSS use case (news typically
     doesn't change much after 30d). Could be 7d or 90d. Pick 30d, revisit
     if feedback warrants.

5. **Should we also archive the feed URL itself?**
   - Out of scope for v1. The feature as specified targets *notification
     URLs*, not feed sources. Could be a separate future feature
     (`WACHI_ARCHIVE_FEEDS=1`).

## 11. Files Touched (summary)

### New files

- `src/lib/archive/client.ts`
- `src/lib/archive/pool.ts`
- `src/lib/archive/submit.ts`
- `src/lib/archive/url-policy.ts`
- `test/unit/lib/archive/client.test.ts`
- `test/unit/lib/archive/pool.test.ts`
- `test/unit/lib/archive/submit.test.ts`
- `test/unit/lib/archive/url-policy.test.ts`
- `test/integration/handle-items-archive.test.ts`
- `test/e2e/archive-disabled.test.ts`
- `test/e2e/archive-enabled.test.ts`
- `test/fixtures/mock-wayback-server.ts`

### Modified files

- `src/utils/env.ts` — add three env vars
- `src/lib/check/handle-items.ts` — one-line `submitArchive(item.link, ...)`
- `src/lib/check/run-check.ts` — one-line `await flushArchivePool()`
- `test/unit/utils/env.test.ts` — extend
- `README.md` — env var table
- `SPEC.md` — short subsection under notifications

### NOT touched (intentionally)

- `src/lib/db/schema.ts` — no schema changes (stateless design)
- `drizzle/` — no migration needed
- `src/lib/notify/send.ts` — sacred path, untouched
- `src/lib/notify/format.ts` — body format unchanged
- `src/commands/test.ts` — test command does not archive (no real link)
- `src/lib/check/handle-failure.ts` — failure alerts do not archive
