import { describe, expect, it } from "bun:test";
import {
  countByHost,
  findOutagedHosts,
  HOST_OUTAGE_MIN_SUBSCRIPTIONS,
  toRssHost,
} from "../../../../src/lib/check/detect-host-outage.ts";

describe("toRssHost", () => {
  it("keeps the port so co-hosted services stay distinct", () => {
    expect(toRssHost("http://localhost:8677/atom?url=x")).toBe("localhost:8677");
    expect(toRssHost("http://localhost:1200/twitter/user/y")).toBe("localhost:1200");
    expect(toRssHost("http://localhost:8677/a")).not.toBe(toRssHost("http://localhost:1200/a"));
  });

  it("ignores path, query and scheme", () => {
    expect(toRssHost("https://github.com/a/b.atom?x=1")).toBe("github.com");
    expect(toRssHost("http://github.com/c")).toBe("github.com");
  });

  it("returns null for unparseable input", () => {
    expect(toRssHost("not-a-url")).toBeNull();
    expect(toRssHost("")).toBeNull();
  });
});

describe("countByHost", () => {
  it("counts subscriptions per host and drops unparseable entries", () => {
    const counts = countByHost([
      "http://localhost:8677/a",
      "http://localhost:8677/b",
      "http://localhost:1200/c",
      "not-a-url",
      null,
    ]);

    expect(counts.get("localhost:8677")).toBe(2);
    expect(counts.get("localhost:1200")).toBe(1);
    expect(counts.size).toBe(2);
  });
});

describe("findOutagedHosts", () => {
  const find = (attempts: [string, number][], failures: [string, number][]) =>
    findOutagedHosts({
      attemptsByHost: new Map(attempts),
      failuresByHost: new Map(failures),
    });

  it("uses the documented minimum", () => {
    expect(HOST_OUTAGE_MIN_SUBSCRIPTIONS).toBe(3);
  });

  it("flags a host whose every subscription failed", () => {
    expect([...find([["localhost:8677", 17]], [["localhost:8677", 17]])]).toEqual([
      "localhost:8677",
    ]);
  });

  it("does not flag a host with a single surviving subscription", () => {
    expect([...find([["localhost:8677", 17]], [["localhost:8677", 16]])]).toEqual([]);
  });

  it("does not flag hosts below the minimum subscription count", () => {
    expect([...find([["a.example", 2]], [["a.example", 2]])]).toEqual([]);
    expect([...find([["a.example", 1]], [["a.example", 1]])]).toEqual([]);
    expect([...find([["a.example", 3]], [["a.example", 3]])]).toEqual(["a.example"]);
  });

  it("evaluates hosts independently", () => {
    const found = find(
      [
        ["localhost:8677", 4],
        ["localhost:1200", 19],
        ["github.com", 15],
      ],
      [
        ["localhost:8677", 4],
        ["localhost:1200", 1],
      ],
    );

    expect([...found].sort()).toEqual(["localhost:8677"]);
  });

  it("ignores hosts that had no failures", () => {
    expect([...find([["github.com", 15]], [])]).toEqual([]);
  });

  it("is empty when nothing was attempted", () => {
    expect([...find([], [["ghost.example", 3]])]).toEqual([]);
  });
});
