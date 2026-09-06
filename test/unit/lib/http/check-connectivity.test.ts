import { describe, expect, it } from "bun:test";
import { FetchError } from "ofetch";
import {
  isNetworkLevelError,
  NetworkLevelError,
} from "../../../../src/lib/http/check-connectivity.ts";

describe("isNetworkLevelError", () => {
  it("returns true for a FetchError without statusCode", () => {
    const error = new FetchError("fetch failed");
    expect(isNetworkLevelError(error)).toBe(true);
  });

  it("returns true for an explicitly classified transport failure", () => {
    expect(isNetworkLevelError(new NetworkLevelError("timeout", "request timed out"))).toBe(true);
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
