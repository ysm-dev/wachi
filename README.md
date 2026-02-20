# wachi

[![npm version](https://img.shields.io/npm/v/wachi)](https://www.npmjs.com/package/wachi)
[![CI](https://github.com/ysm-dev/wachi/actions/workflows/release.yml/badge.svg)](https://github.com/ysm-dev/wachi/actions)
[![license](https://img.shields.io/npm/l/wachi)](https://github.com/ysm-dev/wachi/blob/main/LICENSE)

**Subscribe any link and get notified on change.**

wachi monitors any URL for new content and pushes notifications to 90+ services via [apprise](https://github.com/caronc/apprise). It auto-discovers RSS feeds when available, and uses LLM-powered CSS selector identification for everything else.

- **Zero config for RSS** -- point at a blog, wachi finds the feed
- **LLM-powered for the rest** -- no RSS? wachi uses AI to identify content selectors via accessibility tree analysis
- **90+ notification services** -- Slack, Discord, Telegram, email, and [more](https://github.com/caronc/apprise/wiki)
- **Stateless by design** -- `wachi check` is a one-shot command, perfect for cron
- **No interactive prompts** -- built for automation and AI agents

## Install

```bash
# npm / bun
npx wachi --help
bunx wachi --help

# or install globally
npm i -g wachi
bun i -g wachi

# shell script
curl -fsSL https://raw.githubusercontent.com/ysm-dev/wachi/main/install.sh | sh

# homebrew
brew tap ysm-dev/tap && brew install wachi
```

## Quick Start

```bash
# 1. Subscribe to any URL (auto-discovers RSS)
wachi sub "slack://xoxb-token/channel" "https://blog.example.com"

# 2. Check for new content (run this on a schedule)
wachi check

# That's it. New posts get pushed to your Slack channel.
```

## How It Works

```
wachi sub <apprise-url> <url>
      │
      ▼
  Is it RSS? ───yes───▶ Store as RSS subscription
      │no
      ▼
  Auto-discover RSS ───found───▶ Store URL + discovered feed
  (link tags, common paths)
      │not found
      ▼
  LLM identifies content via accessibility tree
      │
  Derive CSS selectors from DOM (deterministic)
      │
  Validate selectors against raw HTTP
      │
  Store URL + selectors + baseline
```

On `wachi check`, each subscription is fetched and compared against a dedup table. New items trigger notifications via apprise. Old items are skipped. That's it.

## Commands

```
wachi sub <apprise-url> <url>     Subscribe a URL to a notification channel
  -e, --send-existing             Send all current items on next check (skip baseline)

wachi unsub <apprise-url> [url]   Unsubscribe a URL or remove entire channel

wachi ls                          List all channels and subscriptions

wachi check                       Check all subscriptions for changes
  -c, --channel <apprise-url>     Check specific channel only
  -n, --concurrency <number>      Max concurrent checks (default: 10)
  -d, --dry-run                   Preview without sending or recording

wachi test <apprise-url>          Send a test notification

wachi upgrade                     Update wachi to latest version
```

**Global flags:** `--json` / `-j` for machine-readable output, `--verbose` / `-V` for detailed logs, `--config` / `-C` for custom config path.

## Examples

```bash
# Blog (auto-discovers RSS)
wachi sub "slack://xoxb-token/channel" "https://blog.example.com"

# Hacker News front page (LLM identifies content selectors)
wachi sub "discord://webhook-id/token" "https://news.ycombinator.com"

# YouTube channel
wachi sub "tgram://bot-token/chat-id" "https://youtube.com/@channel"

# URL without https:// (auto-prepended)
wachi sub "slack://token/channel" "blog.example.com"

# Send all existing items on next check (no baseline)
wachi sub -e "discord://webhook-id/token" "https://news.ycombinator.com"

# Dry-run: see what would be sent
wachi check -d

# Check specific channel only
wachi check -c "slack://xoxb-token/channel"

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

Test your channel before subscribing:

```bash
wachi test "slack://xoxb-token/channel"
```

## Configuration

Config lives at `~/.config/wachi/config.yml` (XDG-compliant, default). Auto-created on first `wachi sub`.

`wachi` reads config in this order: `config.yml` -> `config.jsonc` -> `config.json`.

```yaml
# LLM config (only needed for non-RSS sites)
# Also settable via WACHI_LLM_API_KEY, WACHI_LLM_MODEL env vars
llm:
  api_key: "sk-..."
  model: "gpt-4.1-mini"

# Optional: summarize articles before sending
summary:
  enabled: true
  language: "en"
  min_reading_time: 3  # minutes

# Channels and subscriptions (managed by wachi sub/unsub)
channels:
  - apprise_url: "slack://xoxb-token/channel"
    subscriptions:
      - url: "https://blog.example.com"
        rss_url: "https://blog.example.com/feed.xml"
      - url: "https://news.ycombinator.com"
        item_selector: "tr.athing"
        title_selector: ".titleline > a"
        link_selector: ".titleline > a"
```

All fields are optional with sensible defaults. An empty config file is valid.

| Variable | Purpose |
|----------|---------|
| `WACHI_LLM_API_KEY` | LLM API key |
| `WACHI_LLM_MODEL` | LLM model name |
| `WACHI_LLM_BASE_URL` | LLM API base URL (default: OpenAI) |
| `WACHI_NO_AUTO_UPDATE` | Set to `1` to disable auto-update |

## Design

- **Stateless checks** -- `wachi check` is a one-shot command. Bring your own scheduler (cron, crnd, systemd, launchd)
- **Dedup, not state** -- items tracked by `sha256(link + title + channel)`. If the hash exists, it was already sent
- **No interactive prompts** -- ever. Errors tell you exactly what to set and where (What / Why / Fix pattern)
- **Baseline seeding** -- on subscribe, all current items are pre-seeded so your channel isn't flooded
- **Auto-healing** -- CSS selectors go stale? After 3 consecutive failures, wachi re-identifies them automatically
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
| LLM | [Vercel AI SDK](https://github.com/vercel/ai) v6 |
| RSS | [rss-parser](https://github.com/rbren/rss-parser) |
| HTML | [cheerio](https://github.com/cheeriojs/cheerio) |
| Notifications | [apprise](https://github.com/caronc/apprise) via uvx |
| Linter | [Biome](https://biomejs.dev/) v2 |

## License

MIT
