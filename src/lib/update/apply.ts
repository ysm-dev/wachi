import { access, chmod, rename } from "node:fs/promises";
import { getPendingUpdatePath } from "../../utils/paths.ts";
import { detectInstallMethod } from "./detect-method.ts";

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

export const applyPendingAutoUpdate = async (): Promise<boolean> => {
  const pendingPath = getPendingUpdatePath();
  if (!(await fileExists(pendingPath))) {
    return false;
  }

  const currentBinaryPath = process.execPath;
  if (!currentBinaryPath || currentBinaryPath.endsWith("bun")) {
    return false;
  }

  if (detectInstallMethod(currentBinaryPath) !== "binary") {
    return false;
  }

  const backupPath = `${currentBinaryPath}.bak`;

  await rename(currentBinaryPath, backupPath);
  await rename(pendingPath, currentBinaryPath);
  await chmod(currentBinaryPath, 0o755);
  return true;
};
