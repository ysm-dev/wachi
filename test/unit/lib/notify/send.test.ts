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
});
