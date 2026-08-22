import { beforeEach, describe, expect, it } from "bun:test";
import { runRateLimitedChecks } from "../../../../src/lib/check/run-rate-limited-checks.ts";
import { resetDomainRateLimitsForTest } from "../../../../src/lib/http/rate-limit.ts";

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

beforeEach(() => {
  resetDomainRateLimitsForTest();
});

describe("runRateLimitedChecks", () => {
  it("creates only bounded active work", async () => {
    const items = Array.from({ length: 1_000 }, (_, index) => ({
      targetUrl: `https://host-${index}.example/feed`,
    }));
    let active = 0;
    let peakActive = 0;

    await runRateLimitedChecks(items, 7, async () => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await sleep(1);
      active -= 1;
    });

    expect(peakActive).toBe(7);
  });

  it("does not let a blocked host take a slot from another host", async () => {
    const started: string[] = [];
    const items = [
      { targetUrl: "https://a.example/1" },
      { targetUrl: "https://a.example/2" },
      { targetUrl: "https://b.example/1" },
    ];

    await runRateLimitedChecks(
      items,
      2,
      async ({ targetUrl }) => {
        started.push(targetUrl);
      },
      30,
    );

    expect(started.slice(0, 2)).toEqual(["https://a.example/1", "https://b.example/1"]);
    expect(started[2]).toBe("https://a.example/2");
  });

  it("allows slow same-host checks to overlap after the start delay", async () => {
    let active = 0;
    let peakActive = 0;
    const startedAt: number[] = [];
    const start = Date.now();

    await runRateLimitedChecks(
      [{ targetUrl: "https://a.example/1" }, { targetUrl: "https://a.example/2" }],
      2,
      async () => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        startedAt.push(Date.now() - start);
        await sleep(70);
        active -= 1;
      },
      30,
    );

    expect(peakActive).toBe(2);
    expect((startedAt[1] ?? 0) - (startedAt[0] ?? 0)).toBeGreaterThanOrEqual(20);
  });

  it("finishes scheduled work and propagates falsy rejection reasons", async () => {
    let runs = 0;
    const result = runRateLimitedChecks(
      [{ targetUrl: "https://a.example/1" }, { targetUrl: "https://b.example/1" }],
      1,
      async ({ targetUrl }) => {
        runs += 1;
        if (targetUrl.includes("a.example")) {
          throw null;
        }
      },
      0,
    );

    await expect(result).rejects.toBeNull();
    expect(runs).toBe(2);
  });
});
