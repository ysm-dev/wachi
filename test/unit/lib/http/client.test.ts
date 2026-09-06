import { afterEach, describe, expect, it } from "bun:test";
import { NetworkLevelError } from "../../../../src/lib/http/check-connectivity.ts";
import { fetchBoundedText } from "../../../../src/lib/http/client.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0, servers.length)) {
    server.stop();
  }
});

describe("fetchBoundedText", () => {
  it("fetches an explicitly requested local hostname through pinned DNS", async () => {
    let receivedHost = "";
    let receivedPath = "";
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        receivedHost = request.headers.get("host") ?? "";
        receivedPath = new URL(request.url).pathname + new URL(request.url).search;
        return new Response("ok");
      },
    });
    servers.push(server);

    const response = await fetchBoundedText(`http://localhost:${server.port}/feed.xml?page=2`, {
      timeoutMs: 1_000,
      maxBytes: 32,
      retry: 0,
    });

    expect(response.body).toBe("ok");
    expect(receivedHost).toBe(`localhost:${server.port}`);
    expect(receivedPath).toBe("/feed.xml?page=2");
  });

  it("finishes a bodyless 304 response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(null, { status: 304, headers: { "content-encoding": "gzip" } });
      },
    });
    servers.push(server);

    const response = await fetchBoundedText(`http://127.0.0.1:${server.port}`, {
      timeoutMs: 1_000,
      maxBytes: 32,
      retry: 0,
    });

    expect(response).toMatchObject({ status: 304, body: "" });
  });

  it("rejects decompressed response text above the byte limit", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(Bun.gzipSync("x".repeat(1_024)), {
          headers: { "content-encoding": "gzip" },
        });
      },
    });
    servers.push(server);

    await expect(
      fetchBoundedText(`http://127.0.0.1:${server.port}`, {
        timeoutMs: 1_000,
        maxBytes: 32,
        retry: 0,
      }),
    ).rejects.toThrow("32-byte limit");
  });

  it("aborts a response body that never finishes", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("<rss>"));
            },
          }),
        );
      },
    });
    servers.push(server);

    await expect(
      fetchBoundedText(`http://127.0.0.1:${server.port}`, {
        timeoutMs: 50,
        maxBytes: 1_024,
        retry: 0,
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("aborts a compressed response body that never finishes", async () => {
    const compressed = Bun.gzipSync("<rss>");
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(compressed.subarray(0, compressed.length - 8));
            },
          }),
          { headers: { "content-encoding": "gzip" } },
        );
      },
    });
    servers.push(server);

    await expect(
      fetchBoundedText(`http://127.0.0.1:${server.port}`, {
        timeoutMs: 50,
        maxBytes: 1_024,
        retry: 0,
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("classifies connection failures as network-level errors", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = server.port ?? 0;
    server.stop();

    await expect(
      fetchBoundedText(`http://127.0.0.1:${port}`, {
        timeoutMs: 1_000,
        maxBytes: 32,
        retry: 0,
      }),
    ).rejects.toBeInstanceOf(NetworkLevelError);
  });
});
