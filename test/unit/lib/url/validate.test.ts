import { afterEach, describe, expect, it } from "bun:test";
import { validateAppriseUrl, validateReachableUrl } from "../../../../src/lib/url/validate.ts";
import { WachiError } from "../../../../src/utils/error.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0, servers.length)) {
    server.stop();
  }
});

describe("validateAppriseUrl", () => {
  it("accepts URI-like apprise URLs", () => {
    expect(() => validateAppriseUrl("slack://token/channel")).not.toThrow();
  });

  it("rejects missing protocol separator", () => {
    expect(() => validateAppriseUrl("slack-token-channel")).toThrow(WachiError);
  });
});

describe("validateReachableUrl", () => {
  it("succeeds for 2xx responses", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("ok", { status: 200 });
      },
    });
    servers.push(server);

    await expect(
      validateReachableUrl(`http://127.0.0.1:${server.port}/ok`),
    ).resolves.toBeUndefined();
  });

  it("wraps HTTP error responses into WachiError", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);

    await expect(
      validateReachableUrl(`http://127.0.0.1:${server.port}/missing`),
    ).rejects.toBeInstanceOf(WachiError);
  });

  it("wraps network failures into WachiError", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("ok", { status: 200 });
      },
    });
    servers.push(server);

    const deadUrl = `http://127.0.0.1:${server.port}/down`;
    server.stop();

    await expect(validateReachableUrl(deadUrl)).rejects.toBeInstanceOf(WachiError);
  });
});
