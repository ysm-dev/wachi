import { afterEach, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchCssSubscriptionItems } from "../../src/lib/subscriptions/fetch-css-subscription-items.ts";
import { WachiError } from "../../src/utils/error.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0, servers.length)) {
    server.stop();
  }
});

const fixturePath = (...parts: string[]): string => {
  return join(process.cwd(), "test", "fixtures", ...parts);
};

describe("fetchCssSubscriptionItems integration", () => {
  it("fetches HTML and extracts items with configured selectors", async () => {
    const html = await readFile(fixturePath("html", "page-with-css-items.html"), "utf8");

    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(html, { headers: { "content-type": "text/html" } });
      },
    });
    servers.push(server);

    const items = await fetchCssSubscriptionItems({
      url: `http://127.0.0.1:${server.port}/news`,
      item_selector: ".entry",
      title_selector: ".headline",
      link_selector: ".headline",
    });

    expect(items).toHaveLength(3);
    expect(items[0]?.title).toBe("First Headline");
  });

  it("throws WachiError on non-2xx response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("blocked", { status: 503 });
      },
    });
    servers.push(server);

    await expect(
      fetchCssSubscriptionItems({
        url: `http://127.0.0.1:${server.port}/news`,
        item_selector: ".entry",
        title_selector: ".headline",
        link_selector: ".headline",
      }),
    ).rejects.toBeInstanceOf(WachiError);
  });
});
