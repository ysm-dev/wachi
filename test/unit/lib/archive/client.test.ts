import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { submitWaybackGet, submitWaybackPost } from "../../../../src/lib/archive/client.ts";

type CapturedRequest = {
  bodyText: string;
  headers: Headers;
  method: string;
  url: string;
};

const originalFetch = globalThis.fetch;

const capturedRequests: CapturedRequest[] = [];
let nextResponse: Response = new Response(JSON.stringify({ job_id: "job-123" }), {
  headers: { "content-type": "application/json" },
});

beforeEach(() => {
  capturedRequests.length = 0;
  nextResponse = new Response(JSON.stringify({ job_id: "job-123" }), {
    headers: { "content-type": "application/json" },
  });

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    capturedRequests.push({
      bodyText: request.method === "GET" ? "" : await request.text(),
      headers: new Headers(request.headers),
      method: request.method,
      url: request.url,
    });
    return nextResponse.clone();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("archive client", () => {
  it("submits authenticated POST requests with server-side dedup options", async () => {
    const signal = new AbortController().signal;

    const result = await submitWaybackPost("https://example.com/post", {
      accessKey: "key-123",
      secretKey: "secret-456",
      signal,
    });

    expect(result).toEqual({ jobId: "job-123" });
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.url).toBe("https://web.archive.org/save");
    expect(capturedRequests[0]?.method).toBe("POST");
    expect(capturedRequests[0]?.headers.get("authorization")).toBe("LOW key-123:secret-456");
    expect(capturedRequests[0]?.headers.get("accept")).toBe("application/json");

    const body = new URLSearchParams(capturedRequests[0]?.bodyText ?? "");
    expect(body.get("url")).toBe("https://example.com/post");
    expect(body.get("if_not_archived_within")).toBe("30d");
    expect(body.get("skip_first_archive")).toBe("1");
  });

  it("throws when the POST response does not include a job id", async () => {
    nextResponse = new Response(JSON.stringify({}), {
      headers: { "content-type": "application/json" },
    });

    await expect(
      submitWaybackPost("https://example.com/post", {
        accessKey: "key-123",
        secretKey: "secret-456",
      }),
    ).rejects.toThrow("job_id");
  });

  it("submits anonymous GET requests without authentication", async () => {
    const signal = new AbortController().signal;
    nextResponse = new Response("ok");

    await submitWaybackGet("https://example.com/post?id=1", { signal });

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.url).toBe(
      "https://web.archive.org/save/https://example.com/post?id=1",
    );
    expect(capturedRequests[0]?.method).toBe("GET");
    expect(capturedRequests[0]?.headers.get("authorization")).toBeNull();
  });
});
