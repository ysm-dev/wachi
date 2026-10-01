# wachi - Subscribe any link and get notified on change

## Goals

- **Cross-platform**: Works on macOS, Linux, Windows
- **Zero config, great defaults**: Works out of the box with sensible defaults
- **No interactive mode**: Built for agents. No stdin prompts ever. Errors tell you exactly what to set and where
- **Stateless invocations**: `wachi check` is a one-shot command designed for cron

## Overview

wachi is a stateless CLI tool that monitors RSS feeds for changes and delivers notifications via [apprise](https://github.com/caronc/apprise). It auto-discovers RSS feeds from any URL.

**Tagline:** Subscribe any link and get notified on change.

## Architecture

```
wachi sub -n <name> [-a <apprise-url>] <url>
       |
       v
  Resolve channel by name
  If channel is new: validate apprise-url format (contains "://")
  Normalize URL (prepend https:// if missing, strip trailing slash)
  Validate URL is reachable (HTTP fetch)
       |
       v
  Is it an RSS URL directly?  ------yes-----> Store as RSS subscription
       |no
       v
  Fetch HTML, auto-discover RSS
  (1. <link rel="alternate"> tags
   2. Common paths: /rss, /rss.xml, /feed, /feed.xml, /atom, /atom.xml)
       |
  RSS found? ------yes-----> Store original URL + discovered RSS URL
       |no
       v
  Error: No RSS feed found for this URL
```

### Ongoing checks (`wachi check`)

```
1. Auto-update check (24h cooldown, non-blocking)          -- always runs (global)
2. For each subscription (concurrent via p-limit, rate-limited per domain):
   (if --name is set, only subscriptions for that channel are checked)
     |
     Fetch RSS (with ETag/If-Modified-Since) --> Parse with rss-parser --> Extract items
     |
     For each item:
       Resolve relative URLs against RSS URL and conservatively canonicalize
       Compute a versioned binary SHA-256 link key
       Atomically insert (physical destination, link key) + outbox payload
       If ignored (duplicate) --> Skip
3. Drain durable outbox rows sequentially per physical destination
4. Print summary: "3 new, 47 unchanged, 0 errors"
```

### Dedup Model

The permanent uniqueness constraint is `(physical destination, SHA-256(canonical original link))`. Titles, channel names, subscription URLs, publication dates, and transformed notification links are metadata, not identity. Duplicate feed records, title changes, channel renames, and overlapping subscriptions cannot admit a second delivery to the same destination.

RSS and Atom publication dates are ignored. Every fetched item is checked against the delivery ledger, regardless of its date or overlap with earlier feed contents. Items are processed in reverse feed order, assuming newest-first source order.

**Item-link canonicalization is deliberately conservative.** Scheme, `www.` prefix, trailing slash, path case, query order, and query case are all preserved, because normalizing any of them can merge two genuinely different items. The **URL fragment is preserved for item links**: anchor-addressed feeds (per-comment permalinks such as `/topic?id=1#cid2`, hash-routed sites) use the fragment as the only discriminator between items, so discarding it collapses many items onto one permanent key and silently suppresses every item after the first, forever. A bare trailing `#` carries no fragment and is dropped so `…/post#` and `…/post` keep one identity.

Subscription (feed) URLs use a separate canonicalization that *does* strip the fragment, since a fragment is never sent to the server and cannot change which document is fetched.

On first subscribe, current items after the first feed entry are inserted as permanent baseline keys and the first entry is admitted through the normal outbox. Use `--send-existing` / `-e` to admit all current items on the next check instead.

**Same URL, multiple destinations:** Allowed once per distinct physical destination. Multiple logical channels targeting the same destination share delivery history.

### Delivery-Key Retention

Delivery keys are compact and permanent. They are never removed by age or count, because deleting a key would make an archived feed item new again. Successful outbox payloads are deleted immediately. Legacy `cleanup` settings remain parseable for config compatibility but do not affect permanent keys.

## Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Language | TypeScript | Fast startup, type safety, rich ecosystem |
| Type checker | tsgo (`@typescript/native-preview`) | 10x faster type checking than tsc |
| Runtime | Bun | bun:sqlite built-in, fast startup, `bun build --compile` for binary distribution |
| Linter/Formatter | Biome v2 | Single tool for linting + formatting, fast, zero config |
| Dead code detection | knip | Find unused dependencies, exports, and files |
| Test runner | bun test | Native Bun test runner, no external dependency |
| CLI framework | citty (unjs/citty) | Zero-dependency, elegant CLI builder with subcommands, auto-generated help |
| Database | drizzle-orm + drizzle-zod + bun:sqlite | Type-safe ORM, zod schema generation, zero manual type declarations |
| Validation | zod + zod-validation-error | Schema validation with human-readable error messages |
| HTTP client | ofetch (unjs/ofetch) | Built-in retry, timeout, interceptors. unjs ecosystem |
| Concurrency | p-limit | Simple concurrency limiter for parallel checks |
| RSS parsing | rss-parser | Most popular Node RSS parser, handles RSS 2.0 + Atom |
| Notifications | apprise (via uvx) | 90+ notification services, zero code needed |
| Config | YAML (default) + JSON | Human-readable, editable. Uses `yaml` package (round-trip to preserve comments) |
| Path resolution | XDG (built-in) | XDG-standard paths for data, config, cache across platforms |

## CLI Design

Verb-first, agent-first design. Plain-text output by default, `--json` / `-j` flag for structured output.

Built with [citty](https://github.com/unjs/citty) using `defineCommand` + `runMain` with subcommands.

All flags have shorthands. All commands support `--help` / `-h`.

Running `wachi` with no subcommand shows help (same as `wachi --help`).

### Commands

```
wachi sub -n <name> <url>         # Subscribe a URL to a notification channel name
  --apprise-url, -a <apprise-url> # Required when creating a new channel name
  --send-existing, -e             # Skip baseline, send all current items on next check
  --help, -h

wachi unsub -n <name> <url>       # Unsubscribe a URL from a channel
wachi unsub -n <name>             # Remove a channel and all its subscriptions
  --help, -h

wachi ls                          # List all channels and subscriptions with website + RSS URLs
  --help, -h

wachi check                       # Check all subscriptions for changes (one-shot)
  --name, -n <name>               # Check specific channel only (housekeeping still runs globally)
  --concurrency, -p <number>      # Max concurrent checks (default: 10)
  --dry-run, -d                   # Show what would be sent without sending or recording
  --help, -h

wachi test -n <name>              # Send a test notification to verify channel works
  --help, -h

wachi upgrade                     # Update wachi to latest version
  --help, -h
```

### Global Flags

```
--json, -j          # Machine-readable JSON output
--verbose, -V       # Show detailed output (HTTP status, timing, dedup decisions)
--config, -C <path> # Custom config file path
--version, -v       # Print version and exit (same output as `wachi version`)
--help, -h          # Show help (auto-generated by citty)
```

### Output Routing

- **stdout**: Command results (ls output, check results, JSON output)
- **stderr**: Warnings, verbose logs, progress messages, errors, diagnostic info

This enables clean piping: `wachi ls --json | jq` works without interference from verbose/warning text.

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success (all operations completed) |
| 1 | Error (fatal: config invalid, DB corrupt, network failure) |
| 2 | Partial success (some subscriptions failed, some succeeded) |

### JSON Output Envelope

All commands with `--json` / `-j` return a consistent envelope:

```json
// Success
{"ok": true, "data": { ... }}

// Error
{"ok": false, "error": {"what": "...", "why": "...", "fix": "..."}}
```

Command-specific `data` shapes:

- `wachi ls --json`: `{"channels": [{"name": "...", "apprise_url": "...", "subscriptions": [{"url": "...", "rss_url": "..."}]}]}`
- `wachi check --json`: `{"sent": [{"title": "...", "link": "...", "channel_name": "main"}], "skipped": 47, "errors": [...]}`
- `wachi sub --json`: `{"channel": "main", "url": "...", "rss_url": "...", "baseline_count": 42}`
- `wachi test --json`: `{"sent": true}`

### Examples

```bash
# Subscribe to a blog via its URL (auto-discovers RSS)
wachi sub -n main -a "slack://xoxb-token/channel" "https://blog.example.com"

# Subscribe and send all existing items on next check
wachi sub -n alerts -a "discord://webhook-id/token" -e "https://news.ycombinator.com"

# Subscribe without https:// (auto-prepended)
wachi sub -n main "blog.example.com"

# List all subscriptions with health indicators
wachi ls

# Run a check (designed to be called by cron/crnd)
wachi check

# Dry-run: see what would be sent without actually sending
wachi check -d

# Check specific channel only
wachi check -n main

# Test a notification channel
wachi test -n main

# Update wachi
wachi upgrade

# Use with crnd for periodic checking
crnd "*/5 * * * *" wachi check
```

### Command Output Formats

**`wachi sub` success output:**

```
Channel: main
Subscribed (RSS): https://blog.example.com
Feed: https://blog.example.com/feed.xml
Baseline: 42 items seeded
```

**`wachi sub` idempotent (already exists):**

```
Already subscribed: https://blog.example.com -> main
```

Exit 0. No-op.

**`wachi unsub` output:**

```
Removed: https://blog.example.com from main
```

or for entire channel removal:

```
Removed channel main (3 subscriptions)
```

**`wachi ls` output (indented tree with website + RSS URLs and health):**

```
main (slack://xoxb-.../channel)
  Website: https://blog.example.com
  RSS: https://blog.example.com/feed.xml

alerts (discord://webhook-id/token)
  Website: https://youtube.com/@channel
  RSS: https://youtube.com/feeds/videos.xml?channel_id=...
```

**`wachi check` output:**

```
sent: Show HN: My Project -> main
sent: New Blog Post Title -> main
sent: Video Title -> alerts
3 new, 47 unchanged, 0 errors
```

**`wachi check --dry-run` output:**

```
[dry-run] would send: Show HN: My Project -> main
[dry-run] would send: New Blog Post Title -> main
[dry-run] 2 items would be sent
```

**`wachi test` output:**

```
Test notification sent to main (slack://xoxb-.../channel)
```

**`--verbose` additional output (to stderr):**

```
[verbose] GET https://blog.example.com/feed.xml -> 200 (342ms)
[verbose] RSS: 25 items parsed
[verbose] skip: Old Post Title (already sent)
[verbose] skip: Another Old Post (already sent)
[verbose] new: Latest Post Title
[verbose] apprise: sent to slack://xoxb-.../channel (1.2s)
```

## Data Model

### Config File

Located at `~/.config/wachi/config.yml` (XDG standard, all platforms). On first run, existing configs are auto-migrated from legacy macOS paths (`~/Library/Preferences/wachi/`).

Config file is created with `0600` permissions (owner read/write only) to protect apprise URLs containing tokens/secrets.

**First-run behavior:** When `wachi sub` is called and no config file exists, wachi auto-creates the config file (and parent directories) with the bare minimum content: just the `channels` array containing the new named channel and subscription. The config path is printed to stderr: `Created config: ~/.config/wachi/config.yml`

**Config writes use atomic write:** Write to `<config path>.tmp`, then `rename()` to the target config path. No lockfile needed. If two concurrent writes race, last one wins (acceptable for CLI).

**YAML comment preservation:** Uses `yaml` package's `parseDocument()` + `toString()` for round-trip parsing that preserves user comments, blank lines, and formatting.

All subscriptions are RSS-based. Each subscription has a `url` (the original URL) and an `rss_url` (the discovered feed URL).

```yaml
# Link transforms: replace hostnames in notification links (e.g., for better embeds)
link_transforms:
  - from: "x.com"
    to: "fixupx.com"
  - from: "twitter.com"
    to: "fxtwitter.com"

# Channels and subscriptions
channels:
  - name: "main"
    apprise_url: "slack://xoxb-token/channel"
    subscriptions:
      - url: "https://blog.example.com"
        rss_url: "https://blog.example.com/feed.xml"

  - name: "alerts"
    apprise_url: "discord://webhook-id/webhook-token"
    subscriptions:
      - url: "https://www.youtube.com/@channel"
        rss_url: "https://www.youtube.com/feeds/videos.xml?channel_id=..."
```

YAML, JSONC, and JSON config files are supported. wachi looks for `config.yml` first, then `config.jsonc`, then `config.json`.

Each channel entry requires a `name` field. Channel names must be unique (case-insensitive).

Config is validated with zod on every read. Errors use `zod-validation-error` for human-readable messages with exact field paths.

**Config schema optionality:** All top-level fields are optional with defaults. An empty config file is valid.

| Field | Required | Default |
|-------|----------|---------|
| `channels` | No | `[]` |
| `link_transforms` | No | `[]` |

### Link Transforms

`link_transforms` replaces hostnames in notification links before sending. This is useful for services like Discord or Slack where embed-friendly URLs (e.g., `fixupx.com` instead of `x.com`) produce better link previews.

Each entry has a `from` (source hostname) and `to` (replacement hostname). Only the hostname is replaced; path, query, and fragment are preserved. The `www.` prefix is stripped for matching (both `x.com` and `www.x.com` match `from: "x.com"`).

Transforms apply only to notification body links. Permanent link keys always use the canonical original link, so changing transforms cannot resend an item.

### SQLite Database

Located at `~/.local/share/wachi/wachi.db` (XDG data dir). On first run, existing databases are auto-migrated from legacy macOS paths (`~/Library/Application Support/wachi/`).

Uses **WAL mode** for safe concurrent reads (cron check running while user runs sub).

**Schema migration:** Embedded drizzle migrations are tracked in `schema_migrations` and applied once inside an immediate transaction.

**Fail-closed recovery:** Initialization and migration errors never delete the database. Wachi stops with an actionable error so permanent delivery history cannot be silently lost.

Schema managed by **drizzle-orm**. Types generated by **drizzle-zod** (no manual type declarations).

The core tables are `destinations`, permanent `delivery_keys`, transient `delivery_outbox`, `health`, `meta`, and `schema_migrations`. `delivery_keys` and `delivery_outbox` use composite primary keys with `WITHOUT ROWID`; link and destination identities are 32-byte BLOBs.

### Concurrent Check Safety

When checks overlap, the composite delivery-key primary key admits one process. Outbox state transitions use immediate transactions, leases, and a partial unique index that permits only one active dispatch per destination across processes.

## URL Handling

### Normalization

- **Auto-prepend protocol:** If URL has no protocol, prepend `https://`. Print resolved URL to stderr: `Using https://example.com`
- **Trailing slash:** Strip trailing slashes before storing. `https://example.com/` becomes `https://example.com`
- **www vs non-www:** Treated as different URLs (they may serve different content)

### Relative URL Resolution

RSS items may contain relative URLs (`/post/123`). These are resolved against the RSS URL. Only valid HTTP(S) item links or URL-like GUIDs are admitted; opaque or missing GUIDs do not fall back to the subscription URL.

### Redirect Handling

Store the user-provided URL in config. `ofetch` follows redirects transparently. If the redirect destination changes later, it still works. User sees the URL they typed.

### Apprise URL Validation

Basic format check only: verify the apprise URL contains `://` (is a URI). Don't validate specific service formats -- that's apprise's job. If apprise fails at notification time, the error surfaces via the health tracking system.

## Change Detection

### 1. RSS Detection & Discovery

When a user runs `wachi sub -n <name> [-a <apprise-url>] <url>`:

1. If the URL points directly to an RSS/Atom feed (Content-Type contains `xml` or `rss`), use it directly
2. Otherwise, fetch the HTML page and look for RSS feeds:
   a. Parse `<link rel="alternate" type="application/rss+xml">` and `<link rel="alternate" type="application/atom+xml">` tags
   b. Probe common feed paths: `/rss`, `/rss.xml`, `/feed`, `/feed.xml`, `/atom`, `/atom.xml`, `/feed/rss`, `/feed/atom`
3. If multiple RSS feeds found: prefer the first `<link>` tag match (usually the main feed)
4. If RSS found: store both original URL and discovered RSS URL. Use RSS for ongoing checks
5. If no RSS found: error with What/Why/Fix pattern explaining that the URL has no discoverable RSS feed

### RSS Item Field Fallbacks

RSS items may lack `link` or `title`. Use fallback chains:

- **link:** valid HTTP(S) `item.link`, or a URL-like GUID; otherwise reject the item
- **title:** `item.title ?? item.description?.slice(0, 100) ?? "Untitled"`

Never synthesize a duplicate link by falling back to the subscription URL.

### RSS Conditional Requests (ETag / If-Modified-Since)

Store `ETag` and `Last-Modified` per physical destination and RSS URL. Validators are persisted only after all parsed items are durably admitted.

On subsequent fetches, send `If-None-Match` and `If-Modified-Since` headers. If the server returns `304 Not Modified`, skip parsing entirely. Saves bandwidth for frequent checks.

### 2. Ongoing Change Detection

- Fetch the RSS feed via ofetch (with ETag/If-Modified-Since)
- If 304 Not Modified: skip (no changes)
- Parse with rss-parser
- For each item in reverse feed order: canonicalize the link and atomically admit a permanent key plus outbox payload
- After all feed admissions commit, drain durable outbox rows

### 3. Baseline Behavior

When `wachi sub` is called (default, no `--send-existing`):
1. Immediately fetch the current RSS items
2. Insert older items as permanent baseline keys
3. Admit and send the latest link through the normal outbox, if that destination has not seen it
4. Next `wachi check` will only admit genuinely new links

When `wachi sub --send-existing` / `-e` is called:
1. Add subscription to config
2. Mark the subscription cutover without inserting baseline keys
3. Next `wachi check` will admit and send all current links through the outbox

### 4. URL Reachability Validation

During `wachi sub`, the target URL is fetched to verify reachability. If it returns an HTTP error (4xx/5xx) or times out, the subscription is not created. Error follows What/Why/Fix pattern:

```
Error: Failed to reach https://blog.example.com

HTTP 404 Not Found. The URL does not exist.

Check the URL and try again.
```

## Notification Delivery

### Apprise Integration

wachi uses [apprise](https://github.com/caronc/apprise) for notifications, invoked via `uvx`:

```bash
uvx apprise -b "<body>" "<apprise-url>"
```

No `-t` (title) flag is used. The entire notification is sent as the body. Some apprise services ignore `-t` anyway.

**Timeout:** 8 seconds per apprise invocation. The permanent key is retained regardless of outcome.

**1 item = 1 message.** Each new item is sent as a separate notification.

### Notification Message Format

```
<link>

<title>
```

### Notification URL Archiving

- After a notification is successfully delivered, wachi submits the item URL to the Wayback Machine in the background
- For `x.com` / `twitter.com` links, wachi archives the **transformed notification URL** instead of the original URL because Wayback currently rejects direct archiving of those originals (`error:blocked-url`)
- Enabled by default
- Disabled with `WACHI_NO_ARCHIVE=1`
- If `WACHI_ARCHIVE_ACCESS_KEY` and `WACHI_ARCHIVE_SECRET_KEY` are set, wachi uses the authenticated Save Page Now POST API
- If archive keys are unset, wachi falls back to the anonymous Wayback save endpoint
- Archive failures are logged only in verbose mode and never affect dedup state, summaries, or exit codes
- No local archive state is stored; duplicate archive submissions are reduced via Wayback's server-side `if_not_archived_within` option

### Notification Concurrency

- Notifications to the **same physical destination** are sent **sequentially**
- Notifications to **different destinations** are sent **in parallel**
- Within a single RSS/Atom feed, items are sent **oldest first** by reversing the feed's source order (feeds usually publish newest first)
- Ordering across different feeds in the same channel is **not guaranteed**

### Partial Notification Failure

If delivery fails before dispatch starts, the outbox row returns to pending with backoff. Once dispatch starts, any timeout, crash, or nonzero result is ambiguous and becomes `uncertain`; it is not retried automatically because the provider may already have accepted it. The permanent delivery key is never removed.

Before dispatching a queued subscription-failure alert, wachi re-reads the subscription health row. If the recorded failure streak is now below the alert's threshold, the recovered alert is removed without being sent. Ordinary item deliveries are never discarded by this health check.

### `wachi test` Command

Sends a fixed test message: `wachi test notification -- if you see this, your notification channel is working.`

Verifies a saved channel's apprise URL works (after the channel has been created).

### Auto-Installation of uv

If `uvx` is not available, wachi automatically installs uv silently (no prompts):
- macOS/Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh`
- Windows: `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`

After uv is installed, `uvx apprise` works immediately.

## HTTP Client

Uses [ofetch](https://github.com/unjs/ofetch) with a shared instance:

```typescript
import { ofetch } from "ofetch"

export const http = ofetch.create({
  timeout: 30_000,
  retry: 3,
  retryDelay: 1000,
  retryStatusCodes: [408, 429, 500, 502, 503, 504],
  headers: {
    "User-Agent": `wachi/${version} (https://github.com/ysm-dev/wachi)`,
  },
})
```

- **Timeout:** 30 seconds per request
- **Retry:** 3 retries with 1s delay on 408/429/500/502/503/504
- **User-Agent:** `wachi/<version>`
- **Redirects:** Followed transparently by ofetch

## Concurrency & Rate Limiting

When `wachi check` runs:

- **Concurrency:** Subscriptions checked concurrently via [p-limit](https://github.com/sindresorhus/p-limit). Default: 10 (configurable via `--concurrency` / `-p`)
- **Per-domain rate limiting:** Tracked via an in-memory `Map<domain, lastRequestTimestamp>`. Before each request, if less than 1 second has elapsed since the last request to the same domain, `await` the difference. This is separate from p-limit and prevents hammering individual servers

## Auto-Update

Standalone binary installs auto-update on command startup with a 24h cooldown:

1. Detect whether the current executable is a standalone binary install
2. Read updater state from `~/.cache/wachi/update-state.json`
3. If less than 24h since the last check: skip
4. Otherwise: fetch the latest GitHub Release metadata for the current platform/arch
5. If a newer version exists: download the compiled binary to `~/.cache/wachi/wachi-new` and record pending update metadata
6. On the NEXT invocation: at startup, detect the pending update and replace the current binary
7. On Windows, where a running `.exe` cannot replace itself directly, spawn a helper PowerShell process that swaps binaries after the current process exits

This is a **two-phase update**: download happens on one invocation, replacement happens on a later invocation.

Package-manager installs (`npm`, `bun`, `brew`) are **not** auto-updated by wachi. Those are upgraded explicitly through their original package manager.

Disabled with `WACHI_NO_AUTO_UPDATE=1` environment variable.

### `wachi upgrade`

Manual update command. Detects install method from binary location:

- npm global install -> `npm install -g wachi@latest`
- bun global install -> `bun install -g wachi@latest`
- Homebrew install -> `brew upgrade wachi`
- Standalone binary -> download from GitHub Releases and replace the current binary
- `npx`, `bunx`, and project-local installs -> error with exact instructions for rerunning with `@latest` or upgrading the project dependency

For standalone binaries, `wachi upgrade` ignores the auto-update cooldown and upgrades immediately.

### Version Number

Version is baked into the source at build time. A build step writes the version from `package.json` into `src/version.ts`:

```typescript
export const VERSION = "0.1.0"
```

Works in both development (`bun run src/index.ts`) and compiled binary.

## Error Handling

All errors follow the **What / Why / How to fix** pattern:

```
Error: <what happened>

<why it happened>

<how to fix it>
```

Examples:

```
Error: Failed to fetch https://blog.example.com/feed.xml

HTTP 403 Forbidden. The server rejected the request.

The site may be blocking automated requests. Try again later or check if the URL is correct.
```

```
Error: Config validation failed at channels[0].subscriptions[0].url

Expected a valid URL, received "not-a-url".

Fix the value in ~/.config/wachi/config.yml at the specified path.
```

All zod validation errors are wrapped with `zod-validation-error` for human-readable messages.

### Consecutive Failure Tracking

| Consecutive Failures | Action |
|----------------------|--------|
| 1-9 | Silent. Log to SQLite health table. Retry on next check |
| 10 | Notify user: "wachi: subscription <url> has failed 10 consecutive checks. Last error: <error>" |
| 100, then every 100 | Notify user: "wachi: subscription <url> has been failing for <n> consecutive checks. Consider removing it with `wachi unsub -n <name>`" |

### Outage Suppression

Transport failures are correlated across independent hosts before they are acted on. A transport failure matched by the run-level check is reported in the run summary but does not increment `consecutive_failures` and does not raise an alert. HTTP responses, parsing failures, and failures concentrated on one external host remain actionable.

#### Run-Level Outage Suppression

The bounded HTTP client classifies failures that occur before an HTTP response as DNS, connection, TLS, or timeout failures. HTTP status responses and feed parsing failures are not network-level failures.

Classification alone cannot reliably tell "this server is unreachable" from "my network is broken". Correlation across independent hosts provides the second signal: unrelated hosts do not ordinarily become unreachable together.

A run is therefore treated as an environment problem when **both** hold:

- at least **5** subscriptions were attempted in the run, and
- network-level failures span at least **3 distinct hostnames**, and
- at least **50%** of attempted subscriptions had network-level failures.

In that case wachi:

- does **not** increment `consecutive_failures` for the correlated network-level failures
- does **not** send alerts for those network-level failures
- **does** record HTTP, parsing, and other feed-specific failures normally
- **does** still report the errors in the run summary, `--json` output and exit code, so scheduled runs stay honest

Because the ratio can only be known once every subscription has been attempted, failure handling is deferred until the check phase completes.

Below the 5-subscription minimum the ratio is not meaningful, so failures are always handled individually.

#### Host-Level Outage Correlation

A single backend commonly serves many subscriptions: a self-hosted RSSHub or torss instance, or any large public host. That backend is a single point of failure for everything behind it. When it stops, those subscriptions do not represent N broken feeds spread across N channels; they represent one process that is not running.

Such an outage does not need to be a large share of the run. It is therefore reported separately in human and JSON summaries.

Subscriptions are grouped by the **host of `rss_url`, including the port**. The port matters: one machine routinely runs several unrelated feed services on localhost, and one dying must not implicate the others.

A host is treated as down when **both** hold:

- at least **3** of its subscriptions were attempted in the run, and
- **all** of them failed.

Requiring every subscription on the host to fail keeps the correlation meaningful: one dead route on a healthy host still appears as an isolated failure. Host-level correlation does **not** suppress counters or alerts because the outage is external to the wachi runner.

### Health Counter Reset

The `consecutive_failures` counter resets to 0 on **any successful check** (RSS parses successfully). A single success breaks the failure streak.

### State Update Rules

- Item accepted: permanent delivery key and outbox row are committed before network work
- Confirmed delivery: delete only the outbox payload; retain the permanent key
- Pre-dispatch failure: retain pending outbox work with backoff
- Ambiguous post-dispatch failure: retain an uncertain row and never retry automatically
- Check succeeds: reset `consecutive_failures` to 0
- Check fails (HTTP error, timeout, parse error): increment failure counter, no delivery-key changes
- Runner network outage suspected: leave correlated network-failure counters untouched, no delivery-key changes
- External host outage suspected: record failures and alerts normally

## Security

### Config File Protection

- Config file created with `0600` permissions (owner read/write only)
- Apprise URLs containing tokens are stored in plaintext (same pattern as docker, gh, aws CLI)
- Sensitive values can be overridden via environment variables to avoid storing in file:
  - `WACHI_APPRISE_URL` for overriding notification destination

## Configuration

No interactive prompts. Ever. Configuration via env vars or config file only.

If required config is missing, wachi prints a clear error with exact instructions on how to set it (What/Why/Fix pattern).

### Environment Variable Overrides

| Variable | Purpose |
|----------|---------|
| `WACHI_APPRISE_URL` | Override notification destination for ALL channels (redirects where notifications are sent; config channels still define what URLs to check) |
| `WACHI_ARCHIVE_ACCESS_KEY` | Optional Internet Archive access key for authenticated Wayback submissions |
| `WACHI_ARCHIVE_SECRET_KEY` | Optional Internet Archive secret key for authenticated Wayback submissions |
| `WACHI_CONFIG_PATH` | Custom config file path |
| `WACHI_DB_PATH` | Custom database path |
| `WACHI_NO_ARCHIVE` | Set to `1` to disable auto-archiving of notified URLs |
| `WACHI_NO_AUTO_UPDATE` | Set to `1` to disable auto-update |

## Distribution

### npm (primary)

Published as `wachi` on npm with platform-specific binary packages:

```
wachi/                          # Main package (entry point script)
@wachi/darwin-arm64/            # macOS ARM64 binary
@wachi/darwin-x64/              # macOS x64 binary
@wachi/linux-arm64/             # Linux ARM64 binary
@wachi/linux-x64/               # Linux x64 binary
@wachi/win32-x64/               # Windows x64 binary
```

Main package uses `optionalDependencies` to pull the correct platform binary (same pattern as esbuild, turbo, biome):

```json
{
  "name": "wachi",
  "version": "0.1.0",
  "bin": { "wachi": "bin/wachi" },
  "optionalDependencies": {
    "@wachi/darwin-arm64": "0.1.0",
    "@wachi/darwin-x64": "0.1.0",
    "@wachi/linux-arm64": "0.1.0",
    "@wachi/linux-x64": "0.1.0",
    "@wachi/win32-x64": "0.1.0"
  }
}
```

Install/run via:
```bash
npx wachi sub ...
bunx wachi sub ...
npm install -g wachi
```

### Shell script installer

```bash
curl -fsSL https://raw.githubusercontent.com/ysm-dev/wachi/main/install.sh | sh
```

Downloads the correct compiled binary from GitHub Releases on macOS/Linux.

### PowerShell installer (Windows)

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://raw.githubusercontent.com/ysm-dev/wachi/main/install.ps1 | iex"
```

Downloads the latest Windows binary from GitHub Releases into a per-user install directory.

### Homebrew

```bash
brew tap ysm-dev/tap
brew install wachi
```

### GitHub Releases

Each release publishes `bun build --compile` binaries for all 5 platform/arch combinations as GitHub Release assets.

### CI/CD

One GitHub Actions workflow handles verification and releases:
1. On push/PR to `main`: run tests (`bun test`) + type check (`tsgo`) + lint (`biome check`) + dead code (`knip`)
2. On version tag push (`v*`): build `bun build --compile` binaries for all 5 platform/arch targets
3. On version tag push (`v*`): publish to npm (main package + 5 platform packages)
4. On version tag push (`v*`): create GitHub Release with binaries
5. The workflow can also be re-run manually via `workflow_dispatch` on an existing release tag ref

## Project Structure

```
wachi/
  src/
    index.ts                    # CLI entry point (citty runMain)
    version.ts                  # Baked-in version constant
    commands/
      sub.ts                    # wachi sub
      unsub.ts                  # wachi unsub
      ls.ts                     # wachi ls
      check.ts                  # wachi check
      test.ts                   # wachi test
      upgrade.ts                # wachi upgrade
    lib/
      config/
        read.ts                 # Read + validate config (zod, parseDocument for comment preservation)
        write.ts                # Write config with atomic write (temp+rename) + 0600
        schema.ts               # Zod schemas for config (drizzle-zod for DB types)
      db/
        connect.ts              # drizzle-orm setup, tracked migrations, WAL, fail-closed startup
        schema.ts               # drizzle table definitions
        delivery-ledger.ts      # Permanent destination/link keys
        delivery-outbox.ts      # Durable delivery leases and state transitions
        health.ts               # Health tracking operations
        meta.ts                 # Meta key-value operations (auto-update, ETag cache)
      rss/
        detect.ts               # Check if URL is RSS feed (Content-Type)
        discover.ts             # Auto-discover RSS from HTML (link tags + common paths)
        parse.ts                # Parse RSS/Atom feed (rss-parser) with field fallbacks
      notify/
        send.ts                 # Send notification via apprise (uvx), 8s timeout
        destination-identity.ts # Physical destination identity keys
        format.ts               # Format notification message (body only, no -t flag)
        install-uv.ts           # Auto-install uv silently
      http/
        client.ts               # ofetch instance with defaults
        rate-limit.ts           # Per-domain rate limiting (timestamp map + sleep)
      url/
        normalize.ts            # Auto-prepend https://, strip trailing slash
        resolve.ts              # Resolve relative URLs against base
        validate.ts             # Reachability check, apprise URL format check
        transform.ts            # Replace hostnames in links for embed-friendly URLs
      update/
        check.ts                # Check for new version (npm registry)
        apply.ts                # Download binary to cache, two-phase replacement
        detect-method.ts        # Detect install method from binary location
    utils/
      hash.ts                   # SHA-256 hashing
      paths.ts                  # XDG path resolution with legacy macOS migration
      env.ts                    # Environment variable accessors
      error.ts                  # WachiError class (what/why/fix pattern)
  test/
    fixtures/                   # Real-world HTML/RSS fixtures from actual sites
      rss/
        blog-feed.xml
        atom-feed.xml
        malformed-feed.xml
        empty-feed.xml
      html/
        blog-with-rss.html
        blog-without-rss.html
        spa-page.html
        hn-frontpage.html
    unit/
      lib/
        config/read.test.ts
        config/write.test.ts
        config/schema.test.ts
        db/delivery-ledger.test.ts
        db/delivery-outbox.test.ts
        db/health.test.ts
        db/meta.test.ts
        rss/detect.test.ts
        rss/discover.test.ts
        rss/parse.test.ts
        notify/format.test.ts
        notify/install-uv.test.ts
        http/client.test.ts
        http/rate-limit.test.ts
        url/normalize.test.ts
        url/resolve.test.ts
        url/validate.test.ts
        url/transform.test.ts
        update/check.test.ts
        update/detect-method.test.ts
      utils/
        hash.test.ts
        paths.test.ts
        env.test.ts
        error.test.ts
    integration/
      sub-rss.test.ts           # Subscribe to RSS URL end-to-end
      sub-idempotent.test.ts    # Subscribing same URL+channel twice is no-op
      check-rss.test.ts         # Check RSS subscription end-to-end
      check-dry-run.test.ts     # Dry-run mode end-to-end
      unsub.test.ts             # Unsubscribe end-to-end
      handle-items.test.ts      # Permanent link behavior across subscriptions
      baseline.test.ts          # Baseline vs --send-existing behavior
    e2e/
      cli.test.ts               # Full CLI invocation tests (spawn process)
      config-validation.test.ts # Config error messages
      error-messages.test.ts    # Error format validation (What/Why/Fix)
  biome.json
  knip.json
  package.json
  tsconfig.json
  .github/
    workflows/
      release.yml               # Test + build + publish on push to main
```

## Dependencies

All dependencies are installed with `bun i` (never manually edit package.json).

### Runtime

| Package | Purpose |
|---------|---------|
| `citty` | CLI framework |
| `zod` | Schema validation |
| `zod-validation-error` | Human-readable zod errors |
| `drizzle-orm` | Type-safe SQLite ORM |
| `drizzle-zod` | Generate zod schemas from drizzle tables |
| `rss-parser` | RSS/Atom feed parsing |
| `ofetch` | HTTP client with retry/timeout |
| `p-limit` | Concurrency limiter |
| `yaml` | YAML config read/write (round-trip with comment preservation) |
| ~~`env-paths`~~ | Removed; XDG paths computed directly |

### External CLI Tools (subprocess)

| Tool | Purpose | Install |
|------|---------|---------|
| `apprise` (via uvx) | Notification delivery | Auto-installed via uv |

### Dev

| Package | Purpose |
|---------|---------|
| `@typescript/native-preview` | Type checking (tsgo) |
| `@biomejs/biome` | Linting + formatting |
| `knip` | Dead code / unused dependency detection |
| `@types/bun` | Bun type definitions |

## Testing

**Target: 95%+ test coverage.**

Tests run with `bun test` (native Bun test runner).

### Test Layers

| Layer | Scope | Count |
|-------|-------|-------|
| **Unit** | Individual functions, pure logic | ~28 test files |
| **Integration** | Multiple modules working together, real SQLite | ~10 test files |
| **E2E** | Full CLI process spawn, real filesystem | ~3 test files |

### Test Philosophy

- **Deterministic**: No timing-dependent tests, no network calls in unit tests. All external deps mocked. Tests pass 100% of the time on any machine
- **Realistic fixtures**: Real RSS feeds and HTML pages captured from actual sites (blog feeds, HN, malformed XML, empty feeds, huge pages)
- **Error paths tested**: Every error message format (What/Why/Fix) has a corresponding test. Not just happy paths
- **Edge cases**: Malformed RSS, empty feeds, concurrent access, network failures, missing fields, relative URLs, idempotent operations

### Test Conventions

- Unit tests mock external dependencies (HTTP, filesystem, subprocess)
- Integration tests use real in-memory SQLite, temp directories
- E2E tests spawn `bun run src/index.ts` as subprocess, assert stdout/stderr/exit code
- Fixtures in `test/fixtures/` captured from real sites
- All tests are co-located under `test/` mirroring `src/` structure

## Strict Code Conventions

| Rule | Detail |
|------|--------|
| 1 file = 1 exported function | Each file exports one primary function. Helpers are in adjacent files |
| Max 200 lines per file | Except test files which can be longer |
| Co-location | Helpers, constants, types live next to their usage |
| No type assertions | No `as` keyword. Use zod parsing or type guards instead |
| No manual type declarations | Use `z.infer<>` on zod schemas and drizzle-zod for all types |
| All flags have shorthands | Every CLI flag must have a `-x` short form |
| Install with bun i | Never manually edit package.json for dependencies |

## Cron Integration

wachi provides only `wachi check` as a stateless one-shot command. For periodic checking, use any external scheduler:

```bash
# crnd (recommended)
crnd "*/5 * * * *" wachi check

# System cron
crontab -e
*/5 * * * * /usr/local/bin/wachi check

# launchd (macOS) - create plist in ~/Library/LaunchAgents/
# systemd timer (Linux) - create .timer + .service unit
```

## Non-Goals (Explicitly Out of Scope)

- Built-in daemon/scheduler (use crnd, cron, systemd, launchd)
- Authenticated URL support (no cookies, no login flows, no custom headers)
- Non-RSS sites (RSS feeds only)
- JSON API / GraphQL monitoring (RSS only)
- Full page snapshots or visual diffing
- Web UI or dashboard
- Multi-user / server deployment
- Mobile app
- Interactive prompts of any kind

## Implementation Plan

1. Project scaffolding (`bun i` all deps, tsconfig.json, biome.json, knip.json, directory structure)
2. Utils layer (XDG paths, env vars, SHA-256 hashing, WachiError)
3. URL utils (normalize, resolve, validate)
4. Config layer (zod schemas, YAML/JSON round-trip read/write, 0600 permissions, atomic write, validation)
5. Database layer (tracked drizzle migrations, permanent link ledger, durable outbox, WAL, fail-closed recovery)
6. HTTP client (ofetch instance, per-domain rate limiting with timestamp map + sleep)
7. RSS detection + discovery + parsing (with field fallbacks + ETag/If-Modified-Since)
8. CLI scaffolding with citty (all commands wired up, all flags with shorthands, --help on all, version baked in)
9. `wachi sub` command (RSS path + baseline seeding + reachability validation + idempotent check)
10. `wachi ls` command (indented tree format with health indicators)
11. `wachi check` command (RSS admission + p-limit concurrency + rate limiting + durable outbox + dry-run)
12. Apprise notification (uvx, silent uv auto-install, body-only format, 8s timeout, sequential per destination)
13. `wachi test` command (fixed test message)
14. `wachi unsub` command (no confirmation, print what was removed)
15. Health tracking (consecutive failure counting + notifications)
16. Auto-update feature (24h cooldown, two-phase: download to cache, rename on next run)
17. `wachi upgrade` command (detect install method from binary location)
18. `--json` / `-j` flag for all commands (consistent {ok, data, error} envelope)
19. `--verbose` / `-V` flag (HTTP status, timing, dedup decisions to stderr)
20. Error handling pass (all errors follow What/Why/Fix pattern, exit codes 0/1/2)
21. Test suite (unit + integration + e2e, fixtures from real sites, 95%+ coverage)
22. Build pipeline (`bun build --compile` for 5 targets, version baking)
23. GitHub Actions workflow (test + lint + knip + build + publish npm + brew + sh)
