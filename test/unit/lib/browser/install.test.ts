import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureAgentBrowserInstalled } from "../../../../src/lib/browser/install.ts";
import { WachiError } from "../../../../src/utils/error.ts";

type MockProc = {
  exited: Promise<number>;
  stderr?: ReadableStream<Uint8Array>;
};

type SpawnResponse = {
  code: number;
  stderr?: string;
};

const createSpawnMock = (responses: SpawnResponse[]) => {
  const calls: string[][] = [];
  let index = 0;

  const spawn = ((command: string[]) => {
    calls.push(command);

    const response = responses[index] ?? responses[responses.length - 1] ?? { code: 0 };
    index += 1;

    return {
      exited: Promise.resolve(response.code),
      stderr: response.stderr ? (new Response(response.stderr).body ?? undefined) : undefined,
    } as MockProc;
  }) as unknown as typeof Bun.spawn;

  return { spawn, calls };
};

const originalStderrWrite = process.stderr.write;

beforeEach(() => {
  process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = originalStderrWrite;
});

describe("ensureAgentBrowserInstalled", () => {
  it("returns when agent-browser is already available", async () => {
    const { spawn, calls } = createSpawnMock([{ code: 0 }]);

    await expect(
      ensureAgentBrowserInstalled({
        platform: "darwin",
        spawn,
      }),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([["sh", "-lc", "command -v agent-browser"]]);
  });

  it("uses windows command lookup on win32", async () => {
    const { spawn, calls } = createSpawnMock([{ code: 0 }]);

    await expect(
      ensureAgentBrowserInstalled({
        platform: "win32",
        spawn,
      }),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([["cmd", "/c", "where", "agent-browser"]]);
  });

  it("installs agent-browser when command is missing", async () => {
    const { spawn, calls } = createSpawnMock([{ code: 1 }, { code: 0 }]);

    await expect(
      ensureAgentBrowserInstalled({
        platform: "darwin",
        spawn,
      }),
    ).resolves.toBeUndefined();

    expect(calls[1]).toEqual(["npx", "agent-browser", "install"]);
  });

  it("throws WachiError when install command exits non-zero", async () => {
    const { spawn } = createSpawnMock([{ code: 1 }, { code: 1, stderr: "install failed" }]);

    await expect(
      ensureAgentBrowserInstalled({
        platform: "darwin",
        spawn,
      }),
    ).rejects.toBeInstanceOf(WachiError);
  });
});
