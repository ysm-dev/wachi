import { readFile, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  ensureParentDir,
  getPendingUpdatePath,
  getPendingUpdateStatePath,
} from "../../utils/paths.ts";

const updateStateSchema = z.object({
  lastCheckedAt: z.string().optional(),
  pending: z
    .object({
      version: z.string(),
      assetName: z.string(),
      targetPath: z.string(),
    })
    .optional(),
});

export type UpdateState = z.infer<typeof updateStateSchema>;

export const readUpdateState = async (): Promise<UpdateState> => {
  try {
    const raw = await readFile(getPendingUpdateStatePath(), "utf8");
    const parsed = JSON.parse(raw);
    const result = updateStateSchema.safeParse(parsed);
    return result.success ? result.data : {};
  } catch {
    return {};
  }
};

export const writeUpdateState = async (state: UpdateState): Promise<void> => {
  const filePath = getPendingUpdateStatePath();
  await ensureParentDir(filePath);
  await writeFile(filePath, JSON.stringify(state), "utf8");
};

export const clearPendingUpdateState = async (): Promise<void> => {
  const state = await readUpdateState();
  await rm(getPendingUpdatePath(), { force: true });

  if (!state.lastCheckedAt) {
    await rm(getPendingUpdateStatePath(), { force: true });
    return;
  }

  await writeUpdateState({ lastCheckedAt: state.lastCheckedAt });
};
