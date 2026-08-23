import { randomUUID } from "node:crypto";
import { open, readFile, rm, stat } from "node:fs/promises";
import { WachiError } from "../../utils/error.ts";
import { ensureParentDir } from "../../utils/paths.ts";
import { type ReadConfigResult, readConfig } from "./read.ts";
import type { UserConfig } from "./schema.ts";
import { writeConfig } from "./write.ts";

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 15_000;
const INCOMPLETE_LOCK_GRACE_MS = 1_000;
const REAP_LOCK_STALE_MS = LOCK_TIMEOUT_MS;

type Mutation<T> = {
  config?: UserConfig;
  result: T;
};

type MutationResult<T> = {
  configState: ReadConfigResult;
  result: T;
  written: boolean;
};

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

const removeDeadOwnerLock = async (lockPath: string): Promise<void> => {
  const reapPath = `${lockPath}.reap`;
  const reapStat = await stat(reapPath).catch(() => null);
  if (reapStat && Date.now() - reapStat.mtimeMs >= REAP_LOCK_STALE_MS) {
    await rm(reapPath, { force: true });
  }
  let reapHandle: Awaited<ReturnType<typeof open>>;
  try {
    reapHandle = await open(reapPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return;
    }
    throw error;
  }

  try {
    let owner: { pid?: number };
    try {
      owner = JSON.parse(await readFile(lockPath, "utf8"));
    } catch {
      const lockStat = await stat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs >= INCOMPLETE_LOCK_GRACE_MS) {
        await rm(lockPath, { force: true });
      }
      return;
    }

    if (!owner.pid || owner.pid === process.pid) {
      return;
    }

    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        await rm(lockPath, { force: true });
      }
    }
  } finally {
    await reapHandle.close();
    await rm(reapPath, { force: true });
  }
};

const createOwnedLock = async (lockPath: string, token: string): Promise<void> => {
  const handle = await open(lockPath, "wx", 0o600);
  try {
    await handle.writeFile(token, "utf8");
  } catch (error) {
    await rm(lockPath, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
};

const releaseOwnedLock = async (lockPath: string, token: string): Promise<void> => {
  try {
    if ((await readFile(lockPath, "utf8")) === token) {
      await rm(lockPath, { force: true });
    }
  } catch {
    // The lock was already cleaned up.
  }
};

const acquireConfigLock = async (configPath: string): Promise<() => Promise<void>> => {
  const lockPath = `${configPath}.lock`;
  const token = JSON.stringify({ pid: process.pid, id: randomUUID() });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  await ensureParentDir(lockPath);

  while (true) {
    try {
      await createOwnedLock(lockPath, token);
      return () => releaseOwnedLock(lockPath, token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    await removeDeadOwnerLock(lockPath);
    if (!(await stat(lockPath).catch(() => null))) {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new WachiError(
        `Timed out waiting to update config at ${configPath}`,
        "Another wachi process is still updating the config file.",
        "Wait for the other command to finish, then try again.",
      );
    }
    await sleep(LOCK_RETRY_MS);
  }
};

export const mutateConfig = async <T>(
  configPathOverride: string | undefined,
  mutate: (config: UserConfig, state: ReadConfigResult) => Mutation<T>,
): Promise<MutationResult<T>> => {
  const initialState = await readConfig(configPathOverride);
  const release = await acquireConfigLock(initialState.path);

  try {
    const configState = await readConfig(initialState.path);
    const mutation = mutate(structuredClone(configState.rawConfig), configState);
    if (mutation.config) {
      await writeConfig({
        config: mutation.config,
        path: configState.path,
        format: configState.format,
      });
    }
    return { configState, result: mutation.result, written: Boolean(mutation.config) };
  } finally {
    await release();
  }
};
