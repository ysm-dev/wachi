import { describe, expect, it } from "bun:test";
import { withLinkFallbackAvatar } from "../../../../src/lib/subscriptions/resolve-source-identity.ts";

describe("withLinkFallbackAvatar", () => {
  it("keeps the base avatarUrl when present (no override)", () => {
    const result = withLinkFallbackAvatar(
      { username: "Feed", avatarUrl: "https://feed.example/icon.png" },
      "https://post.example/article-1",
    );

    expect(result).toEqual({
      username: "Feed",
      avatarUrl: "https://feed.example/icon.png",
    });
  });

  it("derives avatarUrl from the link when base has none", () => {
    const result = withLinkFallbackAvatar({ username: "Feed" }, "https://post.example/article-1");

    expect(result).toEqual({
      username: "Feed",
      avatarUrl: "https://post.example/favicon.ico",
    });
  });

  it("derives avatarUrl from the link when base is undefined", () => {
    const result = withLinkFallbackAvatar(undefined, "https://blog.example/hello");

    expect(result).toEqual({
      username: undefined,
      avatarUrl: "https://blog.example/favicon.ico",
    });
  });

  it("returns undefined when both base and link yield no avatar or username", () => {
    const result = withLinkFallbackAvatar(undefined, "not a valid url");

    expect(result).toBeUndefined();
  });

  it("preserves username when base has username but link cannot derive an avatar", () => {
    const result = withLinkFallbackAvatar({ username: "Feed" }, "not a url");

    expect(result).toEqual({ username: "Feed", avatarUrl: undefined });
  });
});
