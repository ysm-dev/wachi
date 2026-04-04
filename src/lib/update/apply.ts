import { access, chmod, copyFile, rename, rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { getEnv } from "../../utils/env.ts";
import { WachiError } from "../../utils/error.ts";
import {
  ensureParentDir,
  getPendingUpdatePath,
  getPendingUpdateScriptPath,
  getPendingUpdateStatePath,
} from "../../utils/paths.ts";
import { clearPendingUpdateState, readUpdateState } from "./state.ts";

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
      "  [string]$StatePath = ''",
      ")",
      "$deadline = (Get-Date).AddMinutes(2)",
      "while ($true) {",
      "  try {",
      "    Get-Process -Id $ParentPid -ErrorAction Stop | Out-Null",
      "    Start-Sleep -Milliseconds 200",
      "  } catch {",
      "    break",
      "  }",
      "  if ((Get-Date) -gt $deadline) { exit 1 }",
      "}",
      '$tempPath = "$TargetPath.new"',
      "if (Test-Path $tempPath) { Remove-Item $tempPath -Force }",
      "Copy-Item -Force $StagedPath $tempPath",
      "if (Test-Path $BackupPath) { Remove-Item $BackupPath -Force }",
      "if (Test-Path $TargetPath) { Move-Item -Force $TargetPath $BackupPath }",
      "Move-Item -Force $tempPath $TargetPath",
      "Remove-Item $StagedPath -Force -ErrorAction SilentlyContinue",
      "if ($StatePath -ne '') { Remove-Item $StatePath -Force -ErrorAction SilentlyContinue }",
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  );
  return scriptPath;
};

const quotePowerShell = (value: string): string => {
  return `'${value.replaceAll("'", "''")}'`;
};

const scheduleWindowsReplacement = async (
  currentBinaryPath: string,
  nextBinaryPath: string,
  statePath?: string,
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
    `${quotePowerShell(scriptPath)},`,
    "'-TargetPath',",
    `${quotePowerShell(currentBinaryPath)},`,
    "'-StagedPath',",
    `${quotePowerShell(nextBinaryPath)},`,
    "'-BackupPath',",
    `${quotePowerShell(backupPath)},`,
    "'-ParentPid',",
    `${quotePowerShell(String(process.pid))},`,
    "'-StatePath',",
    `${quotePowerShell(statePath ?? "")}`,
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
  await rename(currentBinaryPath, backupPath);

  try {
    await rename(candidatePath, currentBinaryPath);
  } catch (error) {
    await rename(backupPath, currentBinaryPath).catch(() => undefined);
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
): Promise<"replaced" | "scheduled"> => {
  if (platform === "win32") {
    await scheduleWindowsReplacement(currentBinaryPath, nextBinaryPath, statePath);
    return "scheduled";
  }

  await replacePosixBinary(currentBinaryPath, nextBinaryPath);
  return "replaced";
};

export const applyPendingAutoUpdate = async (): Promise<boolean> => {
  const state = await readUpdateState();
  const pendingPath = getPendingUpdatePath();
  if (!state.pending || !(await fileExists(pendingPath))) {
    if (state.pending) {
      await clearPendingUpdateState();
    }
    return false;
  }

  const currentBinaryPath = process.execPath;
  if (!currentBinaryPath || !isStandaloneInvocation(currentBinaryPath)) {
    return false;
  }

  if (state.pending.targetPath !== currentBinaryPath) {
    return false;
  }

  const outcome = await replaceStandaloneBinary(
    currentBinaryPath,
    pendingPath,
    process.platform,
    getPendingUpdateStatePath(),
  );
  if (outcome === "replaced") {
    await clearPendingUpdateState();
    return true;
  }

  return false;
};
