import { describe, expect, it } from "bun:test";
import {
  ARCHIVE_POOL_FLUSH_TIMEOUT_MS,
  ARCHIVE_POOL_MAX_CONCURRENT,
  createArchivePool,
} from "../../../../src/lib/archive/pool.ts";

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

describe("archive pool", () => {
  it("limits concurrency while draining queued tasks", async () => {
    const pool = createArchivePool();
    let activeCount = 0;
    let peakActiveCount = 0;
    let completedCount = 0;

    for (let index = 0; index < ARCHIVE_POOL_MAX_CONCURRENT * 2; index += 1) {
      pool.trackArchive(async () => {
        activeCount += 1;
        peakActiveCount = Math.max(peakActiveCount, activeCount);
        await sleep(5);
        activeCount -= 1;
        completedCount += 1;
      });
    }

    await pool.flushArchivePool();

    expect(completedCount).toBe(ARCHIVE_POOL_MAX_CONCURRENT * 2);
    expect(peakActiveCount).toBeLessThanOrEqual(ARCHIVE_POOL_MAX_CONCURRENT);
  });

  it("returns after the flush timeout when work is still pending", async () => {
    const pool = createArchivePool();

    pool.trackArchive(async () => {
      await new Promise<void>(() => {});
    });

    const startedAt = Date.now();
    await pool.flushArchivePool(20);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(15);
    expect(elapsedMs).toBeLessThan(ARCHIVE_POOL_FLUSH_TIMEOUT_MS);
  });
});
