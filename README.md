# wachi

[![npm version](https://img.shields.io/npm/v/wachi)](https://www.npmjs.com/package/wachi)
[![CI](https://github.com/ysm-dev/wachi/actions/workflows/release.yml/badge.svg)](https://github.com/ysm-dev/wachi/actions)
[![license](https://img.shields.io/npm/l/wachi)](https://github.com/ysm-dev/wachi/blob/main/LICENSE)

**Monitor RSS feeds and get notified on new content.**

wachi monitors RSS feeds for new content and pushes notifications to 90+ services via [apprise](https://github.com/caronc/apprise). It auto-discovers RSS feeds when available.

- **Zero config for RSS** -- point at a blog, wachi finds the feed
- **90+ notification services** -- Slack, Discord, Telegram, email, and [more](https://github.com/caronc/apprise/wiki)
- **Stateless by design** -- `wachi check` is a one-shot command, perfect for cron
- **No interactive prompts** -- built for automation and AI agents

## Install

```bash
# ephemeral run
npx wachi@latest --help
bunx wachi@latest --help

# persistent global install
npm i -g wachi
bun install -g wachi

# standalone binary (macOS/Linux)
curl -fsSL https://raw.githubusercontent.com/ysm-dev/wachi/main/install.sh | sh

# standalone binary (Windows PowerShell)
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/ysm-dev/wachi/main/install.ps1 | iex"

# homebrew
brew tap ysm-dev/tap && brew install wachi
```

## Quick Start

```bash
# 1. Create a named channel and subscribe a URL (auto-discovers RSS)
wachi sub -n main -a "slack://xoxb-token/channel" "https://blog.example.com"

# 2. Check for new content (run this on a schedule)
wachi check

# That's it. New posts get pushed to your Slack channel.
```

## How It Works

```
wachi sub -n <name> [-a <apprise-url>] <url>
      │
      ▼
  Is it RSS? ───yes───▶ Store as RSS subscription
      │no
      ▼
  Auto-discover RSS ───found───▶ Store URL + discovered feed
  (link tags, common paths)
```

On `wachi check`, each subscription is fetched and compared against a dedup table. New items trigger notifications via apprise. Old items are skipped. That's it.

## Commands

```
wachi sub -n <name> <url>         Subscribe a URL to a named channel
  -a, --apprise-url <url>         Required when creating a new channel
  -e, --send-existing             Send all current items on next check (skip baseline)

wachi unsub -n <name> [url]       Unsubscribe a URL or remove entire channel

wachi ls                          List all channels and subscriptions

wachi check                       Check all subscriptions for changes
  -n, --name <name>               Check specific channel only
  -p, --concurrency <number>      Max concurrent checks (default: 10)
  -d, --dry-run                   Preview without sending or recording

wachi test -n <name>              Send a test notification

wachi upgrade                     Update a persistent wachi install
```

`wachi upgrade` follows the original install method:

- npm global -> `npm install -g wachi@latest`
- bun global -> `bun install -g wachi@latest`
- Homebrew -> `brew upgrade wachi`
- standalone binary -> downloads the latest GitHub Release and replaces the current binary

Ephemeral runs via `npx` and `bunx` are not persistent installs, so they are not upgraded in place. Re-run them with `@latest` instead.

**Global flags:** `--json` / `-j` for machine-readable output, `--verbose` / `-V` for detailed logs, `--config` / `-C` for custom config path.

## Examples

```bash
# Blog (auto-discovers RSS)
wachi sub -n main -a "slack://xoxb-token/channel" "https://blog.example.com"

# GitHub releases RSS feed
wachi sub -n alerts -a "discord://webhook-id/token" "https://github.com/ysm-dev/wachi/releases.atom"

# Add another subscription to an existing channel name
wachi sub -n main "https://example.com/changelog"

# YouTube channel
wachi sub -n media -a "tgram://bot-token/chat-id" "https://youtube.com/@channel"

# URL without https:// (auto-prepended)
wachi sub -n main "blog.example.com"

# Send all existing items on next check (no baseline)
wachi sub -n alerts -e "https://github.com/ysm-dev/wachi/releases.atom"

# Dry-run: see what would be sent
wachi check -d

# Check specific channel only
wachi check -n main

# Run every 5 minutes with crnd
crnd "*/5 * * * *" wachi check

# System cron
crontab -e
# */5 * * * * wachi check
```

## Notifications

wachi uses [apprise](https://github.com/caronc/apprise) for delivery -- Slack, Discord, Telegram, Email, Pushover, Gotify, ntfy, and [90+ more](https://github.com/caronc/apprise/wiki).

Each new item is sent as a separate message:

```
https://blog.example.com/post/new-feature

New Feature: Faster Builds with Incremental Compilation
```

Test a saved channel anytime:

```bash
wachi test -n main
```

## Configuration

Config lives at `~/.config/wachi/config.yml` (XDG-compliant, default). Auto-created on first `wachi sub`.

`wachi` reads config in this order: `config.yml` -> `config.jsonc` -> `config.json`.

```yaml
# Channels and subscriptions (managed by wachi sub/unsub)
channels:
  - name: "main"
    apprise_url: "slack://xoxb-token/channel"
    subscriptions:
      - url: "https://blog.example.com"
        rss_url: "https://blog.example.com/feed.xml"
```

Each channel entry requires `name`. Names must be unique (case-insensitive).

All fields are optional with sensible defaults. An empty config file is valid.

| Variable | Purpose |
|----------|---------|
| `WACHI_APPRISE_URL` | Override notification destination for ALL channels |
| `WACHI_ARCHIVE_ACCESS_KEY` | Optional Internet Archive access key for authenticated Wayback submissions |
| `WACHI_ARCHIVE_SECRET_KEY` | Optional Internet Archive secret key for authenticated Wayback submissions |
| `WACHI_CONFIG_PATH` | Custom config file path |
| `WACHI_DB_PATH` | Custom database path |
| `WACHI_NO_ARCHIVE` | Set to `1` to disable auto-archiving of notified URLs |
| `WACHI_NO_AUTO_UPDATE` | Set to `1` to disable auto-update |

Notified item URLs are archived to the Wayback Machine by default. If archive keys are unset,
`wachi` falls back to the anonymous save endpoint. Set both archive keys for authenticated POST
submissions and higher Wayback limits.

## Design

- **Stateless checks** -- `wachi check` is a one-shot command. Bring your own scheduler (cron, crnd, systemd, launchd)
- **Dedup, not state** -- items tracked by `sha256(link + title + channel)`. If the hash exists, it was already sent
- **No interactive prompts** -- ever. Errors tell you exactly what to set and where (What / Why / Fix pattern)
- **Baseline seeding** -- on subscribe, all current items are pre-seeded so your channel isn't flooded
- **SQLite WAL mode** -- safe concurrent reads. Two cron jobs won't conflict
- **Atomic config writes** -- write to temp, then rename. No corruption from concurrent access
- **JSON envelope** -- `--json` on all commands returns `{"ok": true, "data": {...}}` or `{"ok": false, "error": {"what", "why", "fix"}}`

## Development

```bash
bun install
bun run src/index.ts --help

# Quality checks
bun run lint          # Biome v2
bun run typecheck     # tsgo
bun test              # Bun test runner
bun run knip          # Dead code detection

# Database migrations
bun run db:generate
```

### Tech Stack

| Component | Choice |
|-----------|--------|
| Runtime | Bun (`bun:sqlite`, `bun build --compile`) |
| Type checker | tsgo (`@typescript/native-preview`) |
| CLI | [citty](https://github.com/unjs/citty) |
| Database | [drizzle-orm](https://github.com/drizzle-team/drizzle-orm) + bun:sqlite |
| HTTP | [ofetch](https://github.com/unjs/ofetch) |
| RSS | [rss-parser](https://github.com/rbren/rss-parser) |
| Notifications | [apprise](https://github.com/caronc/apprise) via uvx |
| Linter | [Biome](https://biomejs.dev/) v2 |

## License

MIT
