import { describe, expect, it } from "bun:test";
import { sha256 } from "../../../src/utils/hash.ts";

describe("sha256", () => {
  it("returns stable hashes", () => {
    expect(sha256("wachi")).toBe(sha256("wachi"));
  });

  it("returns different hash for different values", () => {
    expect(sha256("a")).not.toBe(sha256("b"));
  });
});
