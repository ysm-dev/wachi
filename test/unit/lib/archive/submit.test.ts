import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { flushArchivePool, resetArchivePoolForTest } from "../../../../src/lib/archive/pool.ts";
import {
  resetArchiveSubmitStateForTest,
  submitArchive,
} from "../../../../src/lib/archive/submit.ts";

type CapturedRequest = {
  method: string;
  url: string;
};

const envKeys = [
  "WACHI_ARCHIVE_ACCESS_KEY",
  "WACHI_ARCHIVE_SECRET_KEY",
  "WACHI_NO_ARCHIVE",
] as const;

const envSnapshot = new Map<string, string | undefined>();
for (const key of envKeys) {
  envSnapshot.set(key, process.env[key]);
}

const originalFetch = globalThis.fetch;
const originalStderrWrite = process.stderr.write;

const capturedRequests: CapturedRequest[] = [];
let stderrOutput = "";
let fetchError: Error | null = null;

beforeEach(() => {
  capturedRequests.length = 0;
  stderrOutput = "";
  fetchError = null;
  resetArchivePoolForTest();
  resetArchiveSubmitStateForTest();

  for (const key of envKeys) {
    delete process.env[key];
  }

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (fetchError) {
      throw fetchError;
    }

    const request = input instanceof Request ? input : new Request(input, init);
    capturedRequests.push({
      method: request.method,
      url: request.url,
    });

    if (request.method === "POST") {
      return new Response(JSON.stringify({ job_id: "job-123" }), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("ok");
  }) as typeof fetch;

  process.stderr.write = ((chunk: unknown) => {
    stderrOutput += String(chunk);
    return true;
  }) as typeof process.stderr.write;
});

afterEach(async () => {
  await flushArchivePool(100);
  resetArchivePoolForTest();
  resetArchiveSubmitStateForTest();
  globalThis.fetch = originalFetch;
  process.stderr.write = originalStderrWrite;

  for (const key of envKeys) {
    const original = envSnapshot.get(key);
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
});

describe("submitArchive", () => {
  it("does nothing when archive support is disabled", async () => {
    process.env.WACHI_NO_ARCHIVE = "1";

    submitArchive("https://example.com/post");
    await flushArchivePool(100);

    expect(capturedRequests).toHaveLength(0);
  });

  it("uses authenticated POST when both archive keys are configured", async () => {
    process.env.WACHI_ARCHIVE_ACCESS_KEY = "key-123";
    process.env.WACHI_ARCHIVE_SECRET_KEY = "secret-456";

    submitArchive("https://example.com/post");
    await flushArchivePool(100);

    expect(capturedRequests).toEqual([
      {
        method: "POST",
        url: "https://web.archive.org/save",
      },
    ]);
  });

  it("falls back to anonymous GET and prints the hint only once in verbose mode", async () => {
    submitArchive("https://example.com/one", { isVerbose: true });
    submitArchive("https://example.com/two", { isVerbose: true });
    await flushArchivePool(100);

    expect(capturedRequests).toEqual([
      {
        method: "GET",
        url: "https://web.archive.org/save/https://example.com/one",
      },
      {
        method: "GET",
        url: "https://web.archive.org/save/https://example.com/two",
      },
    ]);
    expect(stderrOutput.match(/using anonymous Wayback API/g)?.length ?? 0).toBe(1);
  });

  it("swallows archive failures and logs them only in verbose mode", async () => {
    process.env.WACHI_ARCHIVE_ACCESS_KEY = "key-123";
    process.env.WACHI_ARCHIVE_SECRET_KEY = "secret-456";
    fetchError = new Error("boom");

    submitArchive("https://example.com/post", { isVerbose: true });
    await flushArchivePool(100);

    expect(stderrOutput).toContain("archive: failed for https://example.com/post");
  });
});
