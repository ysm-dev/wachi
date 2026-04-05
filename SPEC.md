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
2. Cleanup old dedup records (TTL 90 days + cap 50k)       -- always runs (global)
3. For each subscription (concurrent via p-limit, rate-limited per domain):
   (if --name is set, only subscriptions for that channel are checked)
     |
     Fetch RSS (with ETag/If-Modified-Since) --> Parse with rss-parser --> Extract items
     |
     For each item:
       Resolve relative URLs against subscription URL
       Compute dedup key: sha256(link + title + channel_name)
       INSERT OR IGNORE into sent_items
       If inserted (new) --> Format notification --> Send via apprise (uvx)
       If ignored (duplicate) --> Skip
4. Print summary: "3 new, 47 unchanged, 0 errors"
```

### Dedup Model

Instead of tracking "seen/unseen" state, wachi uses a simple dedup table. Each item is identified by `sha256(link + title + channel_name)`. If the hash already exists in the database, the item was already sent. If not, it's new -- send it and record the hash.

On first subscribe (`wachi sub`), all current items are pre-seeded into the dedup table (baseline, no cap) so the channel is not flooded. Use `--send-existing` / `-e` flag to skip baseline and send all current items on next check.

**Same URL, multiple channels:** Allowed. Each channel has its own dedup space (hash includes `channel_name`). The same item gets sent to both channels independently.

### Dedup Cleanup

At the start of every `wachi check`, old dedup records are pruned:

- **TTL**: Delete records older than 90 days
- **Count cap**: If more than 50,000 total records remain, delete oldest until 50,000

Both thresholds are configurable via config file:

```yaml
cleanup:
  ttl_days: 90      # default: 90
  max_records: 50000 # default: 50000
```

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

wachi ls                          # List all channels and their subscriptions
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

- `wachi ls --json`: `{"channels": [{"name": "...", "apprise_url": "...", "subscriptions": [...]}]}`
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

**`wachi ls` output (indented tree with health):**

```
main (slack://xoxb-.../channel)
  https://blog.example.com (RSS)

alerts (discord://webhook-id/token)
  https://youtube.com/@channel (RSS)
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

**First-run behavior:** When `wachi sub` is called and no config file exists, wachi auto-creates the config file (and parent directories) with the bare minimum content: just the `channels` array containing the new named channel and subscription. No commented-out template sections (no `cleanup` stubs). The config path is printed to stderr: `Created config: ~/.config/wachi/config.yml`

**Config writes use atomic write:** Write to `<config path>.tmp`, then `rename()` to the target config path. No lockfile needed. If two concurrent writes race, last one wins (acceptable for CLI).

**YAML comment preservation:** Uses `yaml` package's `parseDocument()` + `toString()` for round-trip parsing that preserves user comments, blank lines, and formatting.

All subscriptions are RSS-based. Each subscription has a `url` (the original URL) and an `rss_url` (the discovered feed URL).

```yaml
# Dedup cleanup settings
cleanup:
  ttl_days: 90
  max_records: 50000

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
| `cleanup` | No | `{ ttl_days: 90, max_records: 50000 }` |
| `link_transforms` | No | `[]` |

### Link Transforms

`link_transforms` replaces hostnames in notification links before sending. This is useful for services like Discord or Slack where embed-friendly URLs (e.g., `fixupx.com` instead of `x.com`) produce better link previews.

Each entry has a `from` (source hostname) and `to` (replacement hostname). Only the hostname is replaced; path, query, and fragment are preserved. The `www.` prefix is stripped for matching (both `x.com` and `www.x.com` match `from: "x.com"`).

Transforms apply only to notification body links. Dedup hashes always use the original link to avoid re-sending items when transforms change.

### SQLite Database

Located at `~/.local/share/wachi/wachi.db` (XDG data dir). On first run, existing databases are auto-migrated from legacy macOS paths (`~/Library/Application Support/wachi/`).

Uses **WAL mode** for safe concurrent reads (cron check running while user runs sub).

**Schema creation:** Tables are created with `CREATE TABLE IF NOT EXISTS` on every `connectDb()` call. No migration files, no drizzle-kit at runtime. For future column additions, use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

**Corruption recovery:** If the database fails to open or query, wachi deletes the file, recreates it fresh, and warns to stderr: `Warning: Database was corrupted and has been reset. Dedup history lost -- some items may be re-sent on next check.`

Schema managed by **drizzle-orm**. Types generated by **drizzle-zod** (no manual type declarations).

```typescript
// src/lib/db/schema.ts
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

/** Dedup table: tracks all items ever sent to prevent duplicate notifications */
export const sentItems = sqliteTable("sent_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dedupHash: text("dedup_hash").notNull().unique(),  // sha256(link + title + channel_name)
  channelUrl: text("channel_url").notNull(),         // stores channel name
  subscriptionUrl: text("subscription_url").notNull(),
  title: text("title"),
  link: text("link"),
  sentAt: text("sent_at").notNull(),  // ISO 8601
})

/** Tracks consecutive failures per subscription */
export const health = sqliteTable(
  "health",
  {
    channelUrl: text("channel_url").notNull(),
    subscriptionUrl: text("subscription_url").notNull(),
    consecutiveFailures: integer("consecutive_failures").default(0),
    lastError: text("last_error"),
    lastFailureAt: text("last_failure_at"),
  },
  (table) => [primaryKey({ columns: [table.channelUrl, table.subscriptionUrl] })],
)

/** Key-value store for metadata (auto-update cooldown, ETag cache, etc.) */
export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
})
```

### Concurrent Check Safety

When two `wachi check` processes run simultaneously (two cron jobs, or user runs check while cron is running), SQLite dedup handles it naturally. Both processes try `INSERT OR IGNORE` for the same items. One succeeds (insert), the other is ignored (duplicate). Both might send the same notification in a rare race, but it's self-resolving. No process-level locking needed.

## URL Handling

### Normalization

- **Auto-prepend protocol:** If URL has no protocol, prepend `https://`. Print resolved URL to stderr: `Using https://example.com`
- **Trailing slash:** Strip trailing slashes before storing. `https://example.com/` becomes `https://example.com`
- **www vs non-www:** Treated as different URLs (they may serve different content)

### Relative URL Resolution

RSS items may contain relative URLs (`/post/123`). These are resolved against the subscription URL using `new URL(relativeLink, subscriptionUrl)`. All URLs in notifications are absolute.

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

- **link:** `item.link ?? item.guid ?? subscriptionUrl`
- **title:** `item.title ?? item.description?.slice(0, 100) ?? "Untitled"`

Always produce a valid dedup hash from whatever fields are available.

### RSS Conditional Requests (ETag / If-Modified-Since)

Store `ETag` and `Last-Modified` response headers per RSS subscription in the SQLite meta table with composite keys (e.g., key `etag:https://blog.example.com/feed.xml`).

On subsequent fetches, send `If-None-Match` and `If-Modified-Since` headers. If the server returns `304 Not Modified`, skip parsing entirely. Saves bandwidth for frequent checks.

### 2. Ongoing Change Detection

- Fetch the RSS feed via ofetch (with ETag/If-Modified-Since)
- If 304 Not Modified: skip (no changes)
- Parse with rss-parser
- For each item: resolve relative URLs, compute dedup hash, INSERT OR IGNORE into sentItems
- If inserted -> new item -> send notification

### 3. Baseline Behavior

When `wachi sub` is called (default, no `--send-existing`):
1. Immediately fetch the current RSS items
2. Insert ALL items into the dedup table with current timestamp (no cap)
3. No notifications sent
4. Next `wachi check` will only send genuinely new items

When `wachi sub --send-existing` / `-e` is called:
1. Add subscription to config
2. Do NOT pre-seed dedup table
3. Next `wachi check` will send ALL current items as notifications (they're all "new" to the dedup table)

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

**Timeout:** 30 seconds per apprise invocation. If the subprocess doesn't complete in 30s, kill it and log the failure (don't record in dedup, retry on next check).

**1 item = 1 message.** Each new item is sent as a separate notification.

### Notification Message Format

```
<link>

<title>
```

### Notification Concurrency

- Notifications to the **same channel** are sent **sequentially** (preserves chronological order, avoids service rate limits)
- Notifications to **different channels** are sent **in parallel**
- Within each channel, items are ordered **oldest first** (chronological)

### Partial Notification Failure

If apprise fails for item #3 out of 10, wachi:
1. Logs the failure
2. Does NOT record item #3 in dedup (will retry on next check)
3. Continues sending items #4-#10
4. Reports partial failure in the summary line and exits with code 2

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
| 1-2 | Silent. Log to SQLite health table. Retry on next check |
| 3 | Notify user: "wachi: subscription <url> has failed 3 consecutive checks. Last error: <error>" |
| 10+ | Notify user: "wachi: subscription <url> has been failing for 10+ checks. Consider removing it with `wachi unsub -n <name>`" |

### Health Counter Reset

The `consecutive_failures` counter resets to 0 on **any successful check** (RSS parses successfully). A single success breaks the failure streak.

### State Update Rules

- Item sent successfully: recorded in dedup table (never sent again)
- Notification fails: item is NOT recorded in dedup table (retried on next check)
- Check succeeds: reset `consecutive_failures` to 0
- Check fails (HTTP error, timeout, parse error): increment failure counter, no dedup changes

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
| `WACHI_CONFIG_PATH` | Custom config file path |
| `WACHI_DB_PATH` | Custom database path |
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

One GitHub Actions workflow deploys all on push to main:
1. Run tests (`bun test`) + type check (`tsgo`) + lint (`biome check`) + dead code (`knip`)
2. `bun build --compile` for all 5 platform/arch targets
3. Publish to npm (main package + 5 platform packages)
4. Create GitHub Release with binaries
5. Update Homebrew tap formula
6. Upload install.sh

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
        connect.ts              # drizzle-orm setup (bun:sqlite, WAL mode, CREATE TABLE IF NOT EXISTS)
        schema.ts               # drizzle table definitions
        dedup.ts                # Dedup insert/check operations
        cleanup.ts              # Periodic cleanup (TTL + count cap)
        health.ts               # Health tracking operations
        meta.ts                 # Meta key-value operations (auto-update, ETag cache)
      rss/
        detect.ts               # Check if URL is RSS feed (Content-Type)
        discover.ts             # Auto-discover RSS from HTML (link tags + common paths)
        parse.ts                # Parse RSS/Atom feed (rss-parser) with field fallbacks
      notify/
        send.ts                 # Send notification via apprise (uvx), 30s timeout
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
        db/dedup.test.ts
        db/cleanup.test.ts
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
      dedup.test.ts             # Dedup behavior across multiple checks
      baseline.test.ts          # Baseline vs --send-existing behavior
      cleanup.test.ts           # Dedup cleanup TTL + cap
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
5. Database layer (drizzle schema, drizzle-zod types, bun:sqlite WAL, CREATE TABLE IF NOT EXISTS, corruption recovery, dedup + cleanup operations)
6. HTTP client (ofetch instance, per-domain rate limiting with timestamp map + sleep)
7. RSS detection + discovery + parsing (with field fallbacks + ETag/If-Modified-Since)
8. CLI scaffolding with citty (all commands wired up, all flags with shorthands, --help on all, version baked in)
9. `wachi sub` command (RSS path + baseline seeding + reachability validation + idempotent check)
10. `wachi ls` command (indented tree format with health indicators)
11. `wachi check` command (RSS path + dedup + p-limit concurrency + rate limiting + cleanup + dry-run)
12. Apprise notification (uvx, silent uv auto-install, body-only format, 30s timeout, sequential per channel)
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
