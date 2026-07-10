# wachi Detailed Behavior

## Table of Contents

- [Architecture](#architecture)
- [CLI Output Formats](#cli-output-formats)
- [Configuration](#configuration)
- [Change Detection](#change-detection)
- [Notification Delivery](#notification-delivery)
- [Error Handling](#error-handling)
- [Auto-Update](#auto-update)

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
```

### Ongoing checks (`wachi check`)

1. Auto-update check (24h cooldown, non-blocking)
2. For each subscription (concurrent, rate-limited per domain):
   - RSS: Fetch (with ETag/If-Modified-Since) -> Parse -> Extract items
   - Canonicalize each HTTP(S) item link and compute a binary SHA-256 link key
   - Atomically insert `(physical destination, link key)` and a durable outbox row
3. Drain each destination outbox sequentially via apprise
4. Print summary: "3 new, 47 unchanged, 0 errors"

### Dedup Model

Items are identified by a conservative canonical original link. The permanent database key is `(physical destination, SHA-256(canonical link))`; titles, channel names, and subscription URLs are not identity fields. A title edit, channel rename, duplicate feed entry, or duplicate subscription therefore cannot resend the link to the same destination.

The same URL may be sent once to each distinct physical destination. Channels that share a destination, including channels collapsed by `WACHI_APPRISE_URL`, share one delivery history.

### Retention

Delivery keys are compact and permanent. Successful outbox payloads are deleted immediately; only unresolved retry/uncertain payloads remain. Legacy `cleanup` config is accepted for compatibility but does not delete delivery keys.

## CLI Output Formats

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Fatal error |
| 2 | Partial success (some failed, some succeeded) |

### JSON Envelope (`--json`)

```json
{"ok": true, "data": { ... }}
{"ok": false, "error": {"what": "...", "why": "...", "fix": "..."}}
```

### Command Output Examples

**`wachi sub` (RSS):**
```
Channel: main
Subscribed (RSS): https://blog.example.com
Feed: https://blog.example.com/feed.xml
Baseline: 42 items seeded
```

**`wachi sub` (idempotent):**
```
Already subscribed: https://blog.example.com -> main
```

**`wachi ls`:**
```
main (slack://xoxb-.../channel)
  Website: https://blog.example.com
  RSS: https://blog.example.com/feed.xml

alerts (discord://webhook-id/token)
  Website: https://youtube.com/@channel
  RSS: https://youtube.com/feeds/videos.xml?channel_id=...
```

**`wachi check`:**
```
sent: Show HN: My Project -> main
sent: New Blog Post Title -> main
3 new, 47 unchanged, 0 errors
```

**`wachi check --dry-run`:**
```
[dry-run] would send: Show HN: My Project -> main
[dry-run] 2 items would be sent
```

## Configuration

Config at `~/.config/wachi/config.yml` (XDG). Created with `0600` permissions on first `wachi sub`.

Full config example:
```yaml
channels:
  - name: "main"
    apprise_url: "slack://xoxb-token/channel"
    subscriptions:
      - url: "https://blog.example.com"
        rss_url: "https://blog.example.com/feed.xml"
```

Each channel requires a `name` field. Channel names must be unique (case-insensitive).

All top-level fields optional. Empty config is valid.

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `WACHI_APPRISE_URL` | Override notification destination for ALL channels |
| `WACHI_CONFIG_PATH` | Custom config file path |
| `WACHI_DB_PATH` | Custom database path |
| `WACHI_NO_AUTO_UPDATE` | Set to `1` to disable auto-update |

### Data Storage

- **Config**: `~/.config/wachi/config.yml`
- **Database**: `~/.local/share/wachi/wachi.db` (SQLite, WAL mode)
- **Cache**: `~/.cache/wachi/` (pending updates)

Database auto-recovers from corruption: deletes and recreates with a warning.

## Change Detection

### RSS Discovery

1. Check if URL is directly an RSS feed (Content-Type contains `xml`/`rss`)
2. Parse `<link rel="alternate">` tags
3. Probe common paths: `/rss`, `/rss.xml`, `/feed`, `/feed.xml`, `/atom`, `/atom.xml`, `/feed/rss`, `/feed/atom`
4. Prefer first `<link>` tag match

Uses ETag/If-Modified-Since for bandwidth efficiency on subsequent fetches.

### Baseline Behavior

Default: baseline older current items and send the latest link once. With `--send-existing` / `-e`, skip seeding and send all current links on the next check.

## Notification Delivery

### Message Format

```
<link>

<title>
```

### Behavior

- 1 item = 1 message
- Same physical destination: sequential
- Different destinations: parallel
- Within channel: oldest first
- 8s timeout per notification
- Failure before dispatch: retain pending outbox work with backoff
- Failure after dispatch starts: retain an uncertain record and do not retry automatically
- Auto-installs `uv` if `uvx` not available

### Test Notification

`wachi test -n <name>` sends: "wachi test notification -- if you see this, your notification channel is working."

## Error Handling

All errors follow **What / Why / Fix** pattern:

```
Error: <what happened>

<why it happened>

<how to fix it>
```

### Consecutive Failure Tracking

| Failures | Action |
|----------|--------|
| 1-2 | Silent, logged internally |
| 3 | Notify user |
| 10+ | Notify user to consider `wachi unsub` |

Counter resets to 0 on any successful check.

## Auto-Update

Two-phase: download in background on current run, replace binary on next invocation. 24h cooldown. Disabled with `WACHI_NO_AUTO_UPDATE=1`.

`wachi upgrade`: manual update. Detects install method:
- npm/bun -> `npm update -g wachi` / `bun update -g wachi`
- Homebrew -> `brew upgrade wachi`
- Standalone -> download from GitHub Releases
