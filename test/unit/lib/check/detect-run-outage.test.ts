import { describe, expect, it } from "bun:test";
import {
  isRunOutageSuspected,
  OUTAGE_FAILURE_RATIO,
  OUTAGE_MIN_SUBSCRIPTIONS,
} from "../../../../src/lib/check/detect-run-outage.ts";

describe("isRunOutageSuspected", () => {
  it("uses the documented thresholds", () => {
    expect(OUTAGE_MIN_SUBSCRIPTIONS).toBe(5);
    expect(OUTAGE_FAILURE_RATIO).toBe(0.5);
  });

  it("never fires below the minimum sample size, even at 100% failure", () => {
    expect(isRunOutageSuspected({ totalSubscriptions: 1, failureCount: 1 })).toBe(false);
    expect(isRunOutageSuspected({ totalSubscriptions: 2, failureCount: 2 })).toBe(false);
    expect(isRunOutageSuspected({ totalSubscriptions: 4, failureCount: 4 })).toBe(false);
  });

  it("does not fire below the ratio", () => {
    expect(isRunOutageSuspected({ totalSubscriptions: 5, failureCount: 2 })).toBe(false);
    expect(isRunOutageSuspected({ totalSubscriptions: 10, failureCount: 4 })).toBe(false);
    expect(isRunOutageSuspected({ totalSubscriptions: 100, failureCount: 49 })).toBe(false);
  });

  it("fires at exactly the ratio boundary", () => {
    expect(isRunOutageSuspected({ totalSubscriptions: 10, failureCount: 5 })).toBe(true);
    expect(isRunOutageSuspected({ totalSubscriptions: 100, failureCount: 50 })).toBe(true);
  });

  it("fires above the ratio", () => {
    expect(isRunOutageSuspected({ totalSubscriptions: 5, failureCount: 3 })).toBe(true);
    expect(isRunOutageSuspected({ totalSubscriptions: 5, failureCount: 5 })).toBe(true);
    expect(isRunOutageSuspected({ totalSubscriptions: 200, failureCount: 200 })).toBe(true);
  });

  it("handles an empty run without dividing by zero", () => {
    expect(isRunOutageSuspected({ totalSubscriptions: 0, failureCount: 0 })).toBe(false);
  });
});
