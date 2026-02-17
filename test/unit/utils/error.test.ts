import { describe, expect, it } from "bun:test";
import { toWachiError, WachiError } from "../../../src/utils/error.ts";

describe("WachiError", () => {
  it("formats What/Why/Fix output", () => {
    const error = new WachiError("what", "why", "fix", 2);
    expect(error.format()).toBe("Error: what\n\nwhy\n\nfix");
    expect(error.exitCode).toBe(2);
  });
});

describe("toWachiError", () => {
  it("returns the same instance for WachiError", () => {
    const original = new WachiError("what", "why", "fix");
    expect(toWachiError(original)).toBe(original);
  });

  it("wraps regular Error", () => {
    const wrapped = toWachiError(new Error("boom"), "fallback what");
    expect(wrapped.what).toBe("fallback what");
    expect(wrapped.why).toContain("boom");
  });

  it("wraps unknown errors", () => {
    const wrapped = toWachiError("boom", "unknown");
    expect(wrapped.what).toBe("unknown");
    expect(wrapped.why).toContain("unknown error");
  });
});
