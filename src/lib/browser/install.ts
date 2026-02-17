import { commandExists, type SpawnFn } from "../../utils/command.ts";
import { WachiError } from "../../utils/error.ts";

type EnsureAgentBrowserOptions = {
  platform?: NodeJS.Platform;
  spawn?: SpawnFn;
};

export const ensureAgentBrowserInstalled = async (
  options: EnsureAgentBrowserOptions = {},
): Promise<void> => {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? Bun.spawn;

  if (await commandExists("agent-browser", { platform, spawn })) {
    return;
  }

  process.stderr.write("Installing browser for selector detection (one-time, ~200MB)...\n");

  const proc = spawn(["npx", "agent-browser", "install"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new WachiError(
      "Failed to install agent-browser",
      stderr.trim() || "npx agent-browser install failed.",
      "Install it manually with `npx agent-browser install` and try again.",
    );
  }
};
