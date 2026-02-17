import { getEnv } from "../../utils/env.ts";
import { VERSION } from "../../version.ts";
import type { WachiDb } from "../db/connect.ts";
import { getMetaValue } from "../db/get-meta-value.ts";
import { setMetaValue } from "../db/set-meta-value.ts";
import { http } from "../http/client.ts";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const isNewerVersion = (current: string, latest: string): boolean => {
  const currentParts = current.split(".").map((part) => Number(part));
  const latestParts = latest.split(".").map((part) => Number(part));

  const maxLength = Math.max(currentParts.length, latestParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const currentPart = currentParts[index] ?? 0;
    const latestPart = latestParts[index] ?? 0;
    if (latestPart > currentPart) {
      return true;
    }
    if (latestPart < currentPart) {
      return false;
    }
  }
  return false;
};

export const checkForUpdate = async (db: WachiDb): Promise<string | null> => {
  const env = getEnv();
  if (env.noAutoUpdate) {
    return null;
  }

  const lastCheckRaw = getMetaValue(db, "last_update_check");
  if (lastCheckRaw) {
    const lastCheck = Date.parse(lastCheckRaw);
    if (!Number.isNaN(lastCheck) && Date.now() - lastCheck < ONE_DAY_MS) {
      return null;
    }
  }

  setMetaValue(db, "last_update_check", new Date().toISOString());

  try {
    const latestInfo = await http<{ version?: string }>("https://registry.npmjs.org/wachi/latest", {
      retry: 0,
    });
    const latestVersion = latestInfo.version;
    if (!latestVersion) {
      return null;
    }

    if (isNewerVersion(VERSION, latestVersion)) {
      return latestVersion;
    }
  } catch {
    return null;
  }

  return null;
};
