import { describe, expect, it } from "bun:test";
import { validateAppriseUrl } from "../../../../src/lib/url/validate.ts";
import { WachiError } from "../../../../src/utils/error.ts";

describe("validateAppriseUrl", () => {
  it("accepts URI-like apprise URLs", () => {
    expect(() => validateAppriseUrl("slack://token/channel")).not.toThrow();
  });

  it("rejects missing protocol separator", () => {
    expect(() => validateAppriseUrl("slack-token-channel")).toThrow(WachiError);
  });
});
