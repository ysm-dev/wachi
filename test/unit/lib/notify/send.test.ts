import { afterEach, describe, expect, it } from "bun:test";
import { sendNotification } from "../../../../src/lib/notify/send.ts";
import { WachiError } from "../../../../src/utils/error.ts";

type MockProc = {
  exited: Promise<number>;
  stdout?: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
  kill: () => void;
};

const originalSpawn = Bun.spawn;

afterEach(() => {
  Bun.spawn = originalSpawn;
});

const makeStream = (text: string): ReadableStream<Uint8Array> => {
  return new Response(text).body as ReadableStream<Uint8Array>;
};

describe("sendNotification", () => {
  it("succeeds when uvx exists and apprise exits 0", async () => {
    let call = 0;
    Bun.spawn = ((command: string[]) => {
      call += 1;
      if (call === 1) {
        return {
          exited: Promise.resolve(0),
          kill: () => {},
        } as MockProc;
      }

      expect(command[0]).toBe("uvx");
      return {
        exited: Promise.resolve(0),
        stdout: makeStream(""),
        stderr: makeStream(""),
        kill: () => {},
      } as MockProc;
    }) as unknown as typeof Bun.spawn;

    await expect(
      sendNotification({
        appriseUrl: "slack://token/channel",
        body: "hello",
      }),
    ).resolves.toBeUndefined();
  });

  it("throws WachiError when apprise exits non-zero", async () => {
    let call = 0;
    Bun.spawn = (() => {
      call += 1;
      if (call === 1) {
        return {
          exited: Promise.resolve(0),
          kill: () => {},
        } as MockProc;
      }

      return {
        exited: Promise.resolve(1),
        stdout: makeStream(""),
        stderr: makeStream("apprise failed"),
        kill: () => {},
      } as MockProc;
    }) as unknown as typeof Bun.spawn;

    await expect(
      sendNotification({ appriseUrl: "slack://token/channel", body: "hello" }),
    ).rejects.toBeInstanceOf(WachiError);
  });

  it("throws timeout WachiError and kills process when apprise hangs", async () => {
    let call = 0;
    let killed = false;
    Bun.spawn = (() => {
      call += 1;
      if (call === 1) {
        return {
          exited: Promise.resolve(0),
          kill: () => {},
        } as MockProc;
      }

      return {
        exited: new Promise<number>(() => {}),
        stdout: makeStream(""),
        stderr: makeStream(""),
        kill: () => {
          killed = true;
        },
      } as MockProc;
    }) as unknown as typeof Bun.spawn;

    await expect(
      sendNotification({
        appriseUrl: "slack://token/channel",
        body: "hello",
        timeoutMs: 5,
      }),
    ).rejects.toBeInstanceOf(WachiError);

    expect(killed).toBe(true);
  });

  it("injects source identity into supported apprise URLs", async () => {
    let call = 0;
    let sentAppriseUrl = "";
    Bun.spawn = ((command: string[]) => {
      call += 1;
      if (call === 1) {
        return {
          exited: Promise.resolve(0),
          kill: () => {},
        } as MockProc;
      }

      sentAppriseUrl = command[4] ?? "";
      return {
        exited: Promise.resolve(0),
        stdout: makeStream(""),
        stderr: makeStream(""),
        kill: () => {},
      } as MockProc;
    }) as unknown as typeof Bun.spawn;

    await sendNotification({
      appriseUrl: "discord://12345/token",
      body: "hello",
      sourceIdentity: {
        username: "Example Feed",
        avatarUrl: "https://example.com/icon.png",
      },
    });

    expect(sentAppriseUrl).toBe(
      "discord://Example%20Feed@12345/token?avatar_url=https%3A%2F%2Fexample.com%2Ficon.png",
    );
  });

  it("only sets username on schemes without avatar_url support", async () => {
    let call = 0;
    let sentAppriseUrl = "";
    Bun.spawn = ((command: string[]) => {
      call += 1;
      if (call === 1) {
        return {
          exited: Promise.resolve(0),
          kill: () => {},
        } as MockProc;
      }

      sentAppriseUrl = command[4] ?? "";
      return {
        exited: Promise.resolve(0),
        stdout: makeStream(""),
        stderr: makeStream(""),
        kill: () => {},
      } as MockProc;
    }) as unknown as typeof Bun.spawn;

    await sendNotification({
      appriseUrl: "slack://token/channel",
      body: "hello",
      sourceIdentity: {
        username: "Example Feed",
        avatarUrl: "https://example.com/icon.png",
      },
    });

    expect(sentAppriseUrl).toBe("slack://Example%20Feed@token/channel");
  });

  it("leaves unsupported schemes unchanged", async () => {
    let call = 0;
    let sentAppriseUrl = "";
    Bun.spawn = ((command: string[]) => {
      call += 1;
      if (call === 1) {
        return {
          exited: Promise.resolve(0),
          kill: () => {},
        } as MockProc;
      }

      sentAppriseUrl = command[4] ?? "";
      return {
        exited: Promise.resolve(0),
        stdout: makeStream(""),
        stderr: makeStream(""),
        kill: () => {},
      } as MockProc;
    }) as unknown as typeof Bun.spawn;

    await sendNotification({
      appriseUrl: "gotify://token@notify.example.com/topic",
      body: "hello",
      sourceIdentity: {
        username: "Example Feed",
        avatarUrl: "https://example.com/icon.png",
      },
    });

    expect(sentAppriseUrl).toBe("gotify://token@notify.example.com/topic");
  });
});
