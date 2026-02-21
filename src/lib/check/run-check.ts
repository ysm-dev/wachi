import pLimit from "p-limit";
import { z } from "zod";
import { getEnv } from "../../utils/env.ts";
import { printJsonSuccess, printStderr, printStdout } from "../cli/io.ts";
import { toChannelNameKey } from "../config/channel-name-key.ts";
import { readConfig } from "../config/read.ts";
import { writeConfig } from "../config/write.ts";
import { cleanupSentItems } from "../db/cleanup-sent-items.ts";
import { connectDb } from "../db/connect.ts";
import { checkForUpdate } from "../update/check.ts";
import type { CheckStats } from "./handle-items.ts";
import { processSubscriptionCheck } from "./process-subscription.ts";

const runCheckOptionsSchema = z.object({
  name: z.string().optional(),
  concurrency: z.number(),
  dryRun: z.boolean(),
  isJson: z.boolean(),
  isVerbose: z.boolean(),
  configPath: z.string().optional(),
});

type RunCheckOptions = z.infer<typeof runCheckOptionsSchema>;

const createChannelQueue = () => {
  const pending = new Map<string, Promise<void>>();
  return async (channelUrl: string, task: () => Promise<void>): Promise<void> => {
    const previous = pending.get(channelUrl) ?? Promise.resolve();
    const next = previous.then(task, task);
    pending.set(
      channelUrl,
      next.catch(() => {
        return;
      }),
    );
    await next;
  };
};

const printFinalSummary = (stats: CheckStats, dryRun: boolean, isJson: boolean): void => {
  if (isJson) {
    printJsonSuccess({ sent: stats.sent, skipped: stats.skipped, errors: stats.errors });
    return;
  }

  if (dryRun) {
    printStdout(`[dry-run] ${stats.sent.length} items would be sent`);
    return;
  }

  printStdout(
    `${stats.sent.length} new, ${stats.skipped} unchanged, ${stats.errors.length} errors`,
  );
};

const resolveExitCode = (stats: CheckStats): number => {
  if (stats.errors.length === 0) {
    return 0;
  }
  if (stats.sent.length > 0 || stats.skipped > 0) {
    return 2;
  }
  return 1;
};

export const runCheck = async ({
  name,
  concurrency,
  dryRun,
  isJson,
  isVerbose,
  configPath,
}: RunCheckOptions): Promise<number> => {
  const configState = await readConfig(configPath);
  const { sqlite, db } = await connectDb();
  const env = getEnv();

  try {
    const latestVersion = await checkForUpdate(db);
    if (latestVersion && !isJson) {
      printStderr(`Update available: ${latestVersion}`);
    }

    cleanupSentItems(
      db,
      configState.config.cleanup.ttl_days,
      configState.config.cleanup.max_records,
    );

    const channels = name
      ? configState.config.channels.filter(
          (entry) => toChannelNameKey(entry.name) === toChannelNameKey(name),
        )
      : configState.config.channels;

    const stats: CheckStats = { sent: [], skipped: 0, errors: [] };
    const rawConfig = structuredClone(configState.rawConfig);
    let configMutated = false;
    const limit = pLimit(Math.max(1, concurrency));
    const enqueueForChannel = createChannelQueue();
    const tasks: Array<Promise<void>> = [];

    for (const channelEntry of channels) {
      for (const subscription of channelEntry.subscriptions) {
        tasks.push(
          limit(async () => {
            const effectiveChannelUrl = env.appriseUrlOverride ?? channelEntry.apprise_url;
            await processSubscriptionCheck({
              channelName: channelEntry.name,
              effectiveChannelUrl,
              subscription,
              db,
              dryRun,
              isJson,
              isVerbose,
              config: configState.config,
              rawConfig,
              onConfigMutated: () => {
                configMutated = true;
              },
              stats,
              enqueueForChannel,
            });
          }),
        );
      }
    }

    await Promise.all(tasks);

    if (configMutated) {
      await writeConfig({ config: rawConfig, path: configState.path, format: configState.format });
    }

    printFinalSummary(stats, dryRun, isJson);
    return resolveExitCode(stats);
  } finally {
    sqlite.close();
  }
};
