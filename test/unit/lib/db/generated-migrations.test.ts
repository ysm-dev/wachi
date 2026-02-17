import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generatedMigrations } from "../../../../src/lib/db/generated-migrations.ts";

type JournalEntry = {
  tag: string;
};

type DrizzleJournal = {
  entries: JournalEntry[];
};

describe("generated migrations", () => {
  it("stays in sync with drizzle journal entries", () => {
    const journalPath = resolve(process.cwd(), "drizzle/meta/_journal.json");
    const raw = readFileSync(journalPath, "utf8");
    const journal = JSON.parse(raw) as DrizzleJournal;

    expect(generatedMigrations).toHaveLength(journal.entries.length);
  });

  it("contains executable SQL statements", () => {
    for (const migration of generatedMigrations) {
      expect(migration.length).toBeGreaterThan(0);
      expect(/create\s+(table|index)/i.test(migration)).toBe(true);
    }
  });
});
