import { commandExists, type SpawnFn } from "../../utils/command.ts";
import { WachiError } from "../../utils/error.ts";

type EnsureUvxOptions = {
  platform?: NodeJS.Platform;
  spawn?: SpawnFn;
};

const installUv = async (platform: NodeJS.Platform, spawn: SpawnFn): Promise<void> => {
  if (platform === "win32") {
    const proc = spawn([
      "powershell",
      "-ExecutionPolicy",
      "ByPass",
      "-c",
      "irm https://astral.sh/uv/install.ps1 | iex",
    ]);
    if ((await proc.exited) !== 0) {
      throw new WachiError(
        "Failed to install uv",
        "PowerShell installer exited with an error.",
        "Install uv manually from https://docs.astral.sh/uv/ and retry.",
      );
    }
    return;
  }

  const proc = spawn(["sh", "-lc", "curl -LsSf https://astral.sh/uv/install.sh | sh"]);
  if ((await proc.exited) !== 0) {
    throw new WachiError(
      "Failed to install uv",
      "Shell installer exited with an error.",
      "Install uv manually from https://docs.astral.sh/uv/ and retry.",
    );
  }
};

export const ensureUvx = async (options: EnsureUvxOptions = {}): Promise<void> => {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? Bun.spawn;

  if (await commandExists("uvx", { platform, spawn })) {
    return;
  }
  await installUv(platform, spawn);

  if (!(await commandExists("uvx", { platform, spawn }))) {
    throw new WachiError(
      "uvx is unavailable after uv installation",
      "The installer completed but uvx is still not on PATH.",
      "Restart your shell or add uv's bin directory to PATH.",
    );
  }
};
