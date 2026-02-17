import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractCssItems } from "../../../../src/lib/css/extract.ts";
import { validateCssSelectors } from "../../../../src/lib/css/validate.ts";

const fixturePath = (...parts: string[]): string => {
  return join(process.cwd(), "test", "fixtures", ...parts);
};

describe("extractCssItems", () => {
  it("extracts scoped title/link pairs from fixture HTML", async () => {
    const html = await readFile(fixturePath("html", "page-with-css-items.html"), "utf8");
    const items = extractCssItems(html, "https://example.com/news", {
      item_selector: ".entry",
      title_selector: ".headline",
      link_selector: ".headline",
    });

    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ title: "First Headline", link: "https://example.com/a" });
    expect(items[1]).toEqual({ title: "Second Headline", link: "https://example.org/b" });
    expect(items[2]).toEqual({
      title: "Third Headline (no href)",
      link: "https://example.com/news",
    });
  });

  it("validateCssSelectors returns false when selector matches no item", async () => {
    const html = await readFile(fixturePath("html", "page-with-css-items.html"), "utf8");
    const valid = validateCssSelectors(html, "https://example.com/news", {
      item_selector: ".does-not-exist",
      title_selector: ".headline",
      link_selector: ".headline",
    });

    expect(valid).toBe(false);
  });
});
