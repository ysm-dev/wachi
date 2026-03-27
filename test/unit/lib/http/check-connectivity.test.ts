import { afterEach, describe, expect, it, mock } from "bun:test";
import { FetchError } from "ofetch";
import {
  isNetworkAvailable,
  isNetworkLevelError,
} from "../../../../src/lib/http/check-connectivity.ts";

describe("isNetworkLevelError", () => {
  it("returns true for a FetchError without statusCode", () => {
    const error = new FetchError("fetch failed");
    expect(isNetworkLevelError(error)).toBe(true);
  });

  it("returns false for a FetchError with statusCode", () => {
    const error = new FetchError("Internal Server Error");
    error.statusCode = 500;
    expect(isNetworkLevelError(error)).toBe(false);
  });

  it("returns false for a plain Error", () => {
    expect(isNetworkLevelError(new Error("boom"))).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isNetworkLevelError("network error")).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isNetworkLevelError(null)).toBe(false);
    expect(isNetworkLevelError(undefined)).toBe(false);
  });
});

describe("isNetworkAvailable", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns true when fetch succeeds", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch;
    expect(await isNetworkAvailable()).toBe(true);
  });

  it("returns false when fetch throws", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new TypeError("fetch failed")),
    ) as unknown as typeof fetch;
    expect(await isNetworkAvailable()).toBe(false);
  });

  it("passes timeout to AbortSignal", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock((_input: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(new Response("ok"));
    }) as unknown as typeof fetch;

    await isNetworkAvailable(1234);
    expect(capturedInit?.signal).toBeDefined();
    expect(capturedInit?.method).toBe("HEAD");
  });
});
