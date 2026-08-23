import { access, chmod, copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { getEnv } from "../../utils/env.ts";
import { WachiError } from "../../utils/error.ts";
import {
  ensureParentDir,
  getPendingUpdatePath,
  getPendingUpdateScriptPath,
  getPendingUpdateStatePath,
} from "../../utils/paths.ts";
import { VERSION } from "../../version.ts";
import { verifyFileSha256 } from "./download.ts";
import { clearPendingUpdateState, readUpdateState } from "./state.ts";
import { isNewerVersion } from "./version.ts";

const APPLY_LOCK_STALE_MS = 5 * 60 * 1_000;

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const isStandaloneInvocation = (currentBinaryPath: string): boolean => {
  const env = getEnv();
  if (env.wrapperPath) {
    return false;
  }

  const lower = currentBinaryPath.toLowerCase();
  const binaryName = basename(lower);
  if (
    binaryName === "bun" ||
    binaryName === "bun.exe" ||
    binaryName === "node" ||
    binaryName === "node.exe"
  ) {
    return false;
  }

  return !lower.includes("/cellar/wachi/") && !lower.includes("\\cellar\\wachi\\");
};

const writeWindowsApplyScript = async (): Promise<string> => {
  const scriptPath = getPendingUpdateScriptPath();
  await ensureParentDir(scriptPath);
  await writeFile(
    scriptPath,
    [
      "param(",
      "  [string]$TargetPath,",
      "  [string]$StagedPath,",
      "  [string]$BackupPath,",
      "  [int]$ParentPid,",
      "  [string]$StatePath = '',",
      "  [string]$LockPath = ''",
      ")",
      '$ErrorActionPreference = "Stop"',
      '$tempPath = "$TargetPath.new"',
      "$replacementSucceeded = $false",
      "$exitCode = 0",
      "try {",
      "  $deadline = (Get-Date).AddMinutes(2)",
      "  while ($true) {",
      "    try {",
      "      Get-Process -Id $ParentPid -ErrorAction Stop | Out-Null",
      "      Start-Sleep -Milliseconds 200",
      "    } catch {",
      "      break",
      "    }",
      '    if ((Get-Date) -gt $deadline) { throw "Timed out waiting for wachi to exit" }',
      "  }",
      "  if (Test-Path $tempPath) { Remove-Item $tempPath -Force -ErrorAction Stop }",
      "  Copy-Item -Force $StagedPath $tempPath -ErrorAction Stop",
      "  if (Test-Path $BackupPath) { Remove-Item $BackupPath -Force -ErrorAction Stop }",
      "  if (Test-Path $TargetPath) {",
      "    [IO.File]::Replace($tempPath, $TargetPath, $BackupPath, $true)",
      "  } else {",
      "    Move-Item -Force $tempPath $TargetPath -ErrorAction Stop",
      "  }",
      "  $replacementSucceeded = $true",
      "  Remove-Item $StagedPath -Force -ErrorAction Stop",
      "  if ($StatePath -ne '') { Remove-Item $StatePath -Force -ErrorAction Stop }",
      "} catch {",
      "  $exitCode = 1",
      "  if (-not $replacementSucceeded -and -not (Test-Path $TargetPath) -and (Test-Path $BackupPath)) {",
      "    try {",
      "      if (Test-Path $TargetPath) { Remove-Item $TargetPath -Force -ErrorAction Stop }",
      "      Copy-Item -Force $BackupPath $TargetPath -ErrorAction Stop",
      "    } catch {",
      "      # Keep the backup, staged binary, and state file for manual recovery.",
      "    }",
      "  }",
      "} finally {",
      "  if (Test-Path $tempPath) { Remove-Item $tempPath -Force -ErrorAction SilentlyContinue }",
      "  if ($LockPath -ne '') { Remove-Item $LockPath -Recurse -Force -ErrorAction SilentlyContinue }",
      "}",
      "exit $exitCode",
      "",
    ].join("\n"),
    "utf8",
  );
  return scriptPath;
};

const quotePowerShell = (value: string): string => {
  return `'${value.replaceAll("'", "''")}'`;
};

const quoteWindowsProcessArgument = (value: string): string => {
  return quotePowerShell(`"${value}"`);
};

const scheduleWindowsReplacement = async (
  currentBinaryPath: string,
  nextBinaryPath: string,
  statePath?: string,
  lockPath?: string,
): Promise<void> => {
  const scriptPath = await writeWindowsApplyScript();
  const backupPath = `${currentBinaryPath}.bak`;
  const command = [
    "Start-Process",
    "-WindowStyle",
    "Hidden",
    "-FilePath",
    quotePowerShell("powershell"),
    "-ArgumentList",
    "@(",
    "'-NoProfile',",
    "'-ExecutionPolicy',",
    "'Bypass',",
    "'-File',",
    `${quoteWindowsProcessArgument(scriptPath)},`,
    "'-TargetPath',",
    `${quoteWindowsProcessArgument(currentBinaryPath)},`,
    "'-StagedPath',",
    `${quoteWindowsProcessArgument(nextBinaryPath)},`,
    "'-BackupPath',",
    `${quoteWindowsProcessArgument(backupPath)},`,
    "'-ParentPid',",
    `${quoteWindowsProcessArgument(String(process.pid))},`,
    "'-StatePath',",
    `${quoteWindowsProcessArgument(statePath ?? "")},`,
    "'-LockPath',",
    `${quoteWindowsProcessArgument(lockPath ?? "")}`,
    ")",
  ].join(" ");

  try {
    const proc = Bun.spawn(
      ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    );
    if ((await proc.exited) !== 0) {
      throw new Error("powershell exited non-zero");
    }
  } catch {
    throw new WachiError(
      "Failed to schedule the update",
      "A background PowerShell helper could not be started to replace the running executable.",
      "Download the latest release manually or run the upgrade again from an elevated shell.",
    );
  }
};

const replacePosixBinary = async (
  currentBinaryPath: string,
  nextBinaryPath: string,
): Promise<void> => {
  const candidatePath = `${currentBinaryPath}.new`;
  const backupPath = `${currentBinaryPath}.bak`;

  await rm(candidatePath, { force: true });
  await copyFile(nextBinaryPath, candidatePath);
  await chmod(candidatePath, 0o755);
  await rm(backupPath, { force: true });
  await copyFile(currentBinaryPath, backupPath);

  try {
    await rename(candidatePath, currentBinaryPath);
  } catch (error) {
    await rm(candidatePath, { force: true });
    throw error;
  }

  await rm(nextBinaryPath, { force: true });
};

export const replaceStandaloneBinary = async (
  currentBinaryPath: string,
  nextBinaryPath: string,
  platform: NodeJS.Platform = process.platform,
  statePath?: string,
  lockPath?: string,
): Promise<"replaced" | "scheduled"> => {
  if (platform === "win32") {
    await scheduleWindowsReplacement(currentBinaryPath, nextBinaryPath, statePath, lockPath);
    return "scheduled";
  }

  await replacePosixBinary(currentBinaryPath, nextBinaryPath);
  return "replaced";
};

export const acquireUpdateApplyLock = async (): Promise<{
  path: string;
  release: () => Promise<void>;
} | null> => {
  const lockPath = `${getPendingUpdateStatePath()}.apply-lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await ensureParentDir(lockPath);
      await mkdir(lockPath);
      return {
        path: lockPath,
        release: () => rm(lockPath, { recursive: true, force: true }),
      };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }

      if (attempt === 0) {
        const lockStat = await stat(lockPath).catch(() => null);
        if (lockStat && Date.now() - lockStat.mtimeMs >= APPLY_LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      }
      return null;
    }
  }
  return null;
};

export const applyPendingAutoUpdate = async (): Promise<boolean> => {
  if (getEnv().noAutoUpdate) {
    return false;
  }

  const lock = await acquireUpdateApplyLock();
  if (!lock) {
    return false;
  }

  let lockTransferred = false;
  try {
    const state = await readUpdateState();
    const pendingPath = getPendingUpdatePath();
    if (!state.pending || !(await fileExists(pendingPath))) {
      if (state.pending) {
        await clearPendingUpdateState();
      }
      return false;
    }

    if (!isNewerVersion(VERSION, state.pending.version)) {
      await clearPendingUpdateState();
      return false;
    }

    const currentBinaryPath = process.execPath;
    if (!currentBinaryPath || !isStandaloneInvocation(currentBinaryPath)) {
      return false;
    }

    if (state.pending.targetPath !== currentBinaryPath) {
      return false;
    }

    if (!(await verifyFileSha256(pendingPath, state.pending.digest))) {
      await clearPendingUpdateState();
      throw new WachiError(
        "Staged update failed verification",
        "The downloaded release asset changed after it was staged.",
        "Run the command again to download a verified update.",
      );
    }

    const outcome = await replaceStandaloneBinary(
      currentBinaryPath,
      pendingPath,
      process.platform,
      getPendingUpdateStatePath(),
      lock.path,
    );
    if (outcome === "replaced") {
      await clearPendingUpdateState();
      return true;
    }

    lockTransferred = true;
    return false;
  } finally {
    if (!lockTransferred) {
      await lock.release();
    }
  }
};
