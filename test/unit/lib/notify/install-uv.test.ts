import { describe, expect, it } from "bun:test";
import { ensureUvx } from "../../../../src/lib/notify/install-uv.ts";
import { WachiError } from "../../../../src/utils/error.ts";

type MockProc = {
  exited: Promise<number>;
};

const createSpawnMock = (codes: number[]): typeof Bun.spawn => {
  let index = 0;
  return (() => {
    const code = codes[index] ?? codes[codes.length - 1] ?? 0;
    index += 1;
    return { exited: Promise.resolve(code) } as MockProc;
  }) as unknown as typeof Bun.spawn;
};

const createRecordingSpawnMock = (codes: number[]) => {
  const calls: string[][] = [];
  let index = 0;

  const spawn = ((command: string[]) => {
    calls.push(command);
    const code = codes[index] ?? codes[codes.length - 1] ?? 0;
    index += 1;
    return { exited: Promise.resolve(code) } as MockProc;
  }) as unknown as typeof Bun.spawn;

  return { spawn, calls };
};

describe("ensureUvx", () => {
  it("returns when uvx is already available", async () => {
    await expect(
      ensureUvx({
        platform: "darwin",
        spawn: createSpawnMock([0]),
      }),
    ).resolves.toBeUndefined();
  });

  it("installs uv when uvx is missing and then succeeds", async () => {
    await expect(
      ensureUvx({
        platform: "darwin",
        spawn: createSpawnMock([1, 0, 0]),
      }),
    ).resolves.toBeUndefined();
  });

  it("throws WachiError when uv installer exits non-zero", async () => {
    await expect(
      ensureUvx({
        platform: "darwin",
        spawn: createSpawnMock([1, 1]),
      }),
    ).rejects.toBeInstanceOf(WachiError);
  });

  it("throws WachiError when uvx is still missing after install", async () => {
    await expect(
      ensureUvx({
        platform: "darwin",
        spawn: createSpawnMock([1, 0, 1]),
      }),
    ).rejects.toBeInstanceOf(WachiError);
  });

  it("uses windows command lookup and installer flow on win32", async () => {
    const { spawn, calls } = createRecordingSpawnMock([1, 0, 0]);

    await expect(
      ensureUvx({
        platform: "win32",
        spawn,
      }),
    ).resolves.toBeUndefined();

    expect(calls[0]).toEqual(["cmd", "/c", "where", "uvx"]);
    expect(calls[1]).toEqual([
      "powershell",
      "-ExecutionPolicy",
      "ByPass",
      "-c",
      "irm https://astral.sh/uv/install.ps1 | iex",
    ]);
    expect(calls[2]).toEqual(["cmd", "/c", "where", "uvx"]);
  });

  it("throws WachiError when windows installer exits non-zero", async () => {
    await expect(
      ensureUvx({
        platform: "win32",
        spawn: createSpawnMock([1, 1]),
      }),
    ).rejects.toBeInstanceOf(WachiError);
  });
});
