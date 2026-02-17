import { describe, expect, it } from "bun:test";
import { waitForDomainRateLimit } from "../../../../src/lib/http/rate-limit.ts";

describe("waitForDomainRateLimit", () => {
  it("returns early for invalid URLs", async () => {
    await expect(waitForDomainRateLimit("not-a-url", 0)).resolves.toBeUndefined();
  });

  it("tracks repeated valid hostnames without throwing", async () => {
    await expect(waitForDomainRateLimit("https://example.com/a", 0)).resolves.toBeUndefined();
    await expect(waitForDomainRateLimit("https://example.com/b", 0)).resolves.toBeUndefined();
  });
});
