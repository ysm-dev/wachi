# wachi

Subscribe any link and get notified on change.

## Quick start

```bash
bun install
bun run src/index.ts --help
```

## Commands

```bash
wachi sub <apprise-url> <url>
wachi unsub <apprise-url> [url]
wachi ls
wachi check
wachi test <apprise-url>
wachi upgrade
```

## Development checks

```bash
bun run lint
bun run typecheck
bun test
bun run knip
```

## Database schema changes

```bash
bun run db:generate
```

This generates Drizzle SQL migrations and updates `src/lib/db/generated-migrations.ts`.
