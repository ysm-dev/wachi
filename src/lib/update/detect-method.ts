import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize, resolve, sep } from "node:path";
import { getEnv } from "../../utils/env.ts";

export type InstallMethod = "npm" | "bun" | "brew" | "standalone" | "npx" | "bunx" | "project";

type DetectInstallMethodOptions = {
  execPath?: string;
  wrapperPath?: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  bunInstallRoot?: string;
  npmGlobalRoot?: string | null;
  readRealPath?: (filePath: string) => Promise<string>;
  spawn?: typeof Bun.spawn;
};

const normalizePath = (filePath: string): string => {
  return normalize(filePath);
};

const ensureTrailingSeparator = (filePath: string): string => {
  return filePath.endsWith(sep) ? filePath : `${filePath}${sep}`;
};

const safeRealPath = async (
  filePath: string,
  readRealPath: (filePath: string) => Promise<string>,
): Promise<string> => {
  try {
    return normalizePath(await readRealPath(filePath));
  } catch {
    return normalizePath(filePath);
  }
};

const readCommandOutput = async (
  command: string[],
  spawn: typeof Bun.spawn,
): Promise<string | null> => {
  try {
    const proc = spawn(command, { stdout: "pipe", stderr: "ignore" });
    const stdout = proc.stdout ? await new Response(proc.stdout).text() : "";
    if ((await proc.exited) !== 0) {
      return null;
    }
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
};

const isInsidePath = (candidatePath: string, parentPath: string): boolean => {
  const normalizedParentPath = ensureTrailingSeparator(normalizePath(parentPath));
  return ensureTrailingSeparator(candidatePath).startsWith(normalizedParentPath);
};

const isBrewPath = (filePath: string): boolean => {
  const lower = filePath.toLowerCase();
  return (
    lower.includes(`${sep}cellar${sep}wachi${sep}`) ||
    lower.includes(`${sep}homebrew${sep}cellar${sep}wachi${sep}`)
  );
};

const isNodeOrBunRuntime = (filePath: string): boolean => {
  const lower = filePath.toLowerCase();
  return (
    lower.endsWith(`${sep}node`) ||
    lower.endsWith(`${sep}node.exe`) ||
    lower.endsWith(`${sep}bun`) ||
    lower.endsWith(`${sep}bun.exe`)
  );
};

export const detectInstallMethod = async (
  options: DetectInstallMethodOptions = {},
): Promise<InstallMethod> => {
  const env = getEnv();
  const readRealPath = options.readRealPath ?? realpath;
  const spawn = options.spawn ?? Bun.spawn;
  const homeDir = options.homeDir ?? homedir();
  const bunInstallRoot = normalizePath(
    resolve(options.bunInstallRoot ?? process.env.BUN_INSTALL ?? join(homeDir, ".bun")),
  );
  const execPath = options.execPath ?? process.execPath;
  const wrapperPath = options.wrapperPath ?? env.wrapperPath;
  const resolvedExecPath = await safeRealPath(execPath, readRealPath);
  const resolvedWrapperPath = wrapperPath ? await safeRealPath(wrapperPath, readRealPath) : null;

  if (resolvedWrapperPath) {
    if (resolvedWrapperPath.includes(`${sep}_npx${sep}`)) {
      return "npx";
    }

    if (isInsidePath(resolvedWrapperPath, join(bunInstallRoot, "install", "cache"))) {
      return "bunx";
    }

    if (isInsidePath(resolvedWrapperPath, join(bunInstallRoot, "install", "global"))) {
      return "bun";
    }

    const npmGlobalRoot = options.npmGlobalRoot
      ? normalizePath(options.npmGlobalRoot)
      : await readCommandOutput(["npm", "root", "-g"], spawn);

    if (npmGlobalRoot && isInsidePath(resolvedWrapperPath, npmGlobalRoot)) {
      return "npm";
    }

    if (resolvedWrapperPath.includes(`${sep}node_modules${sep}`)) {
      return "project";
    }
  }

  if ((options.platform ?? process.platform) === "darwin" && isBrewPath(resolvedExecPath)) {
    return "brew";
  }

  if (isBrewPath(resolvedExecPath)) {
    return "brew";
  }

  if (isNodeOrBunRuntime(resolvedExecPath)) {
    return "project";
  }

  return "standalone";
};
