import pLimit from "p-limit";
import { z } from "zod";
import { getEnv } from "../../utils/env.ts";
import { flushArchivePool } from "../archive/pool.ts";
import { printJsonSuccess, printStdout } from "../cli/io.ts";
import { toChannelNameKey } from "../config/channel-name-key.ts";
import { readConfig } from "../config/read.ts";
import { connectDb } from "../db/connect.ts";
import { resolveDestinationId } from "../db/delivery-ledger.ts";
import { buildDestinationKey } from "../notify/destination-identity.ts";
import { backfillLegacyDeliveryKeys } from "./delivery-cutover.ts";
import { drainDestinationOutbox } from "./drain-outbox.ts";
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
    printJsonSuccess({
      sent: stats.sent,
      skipped: stats.skipped,
      errors: stats.errors,
      network_skipped: stats.networkSkipped,
    });
    return;
  }

  if (dryRun) {
    printStdout(`[dry-run] ${stats.sent.length} items would be sent`);
    return;
  }

  const parts = [
    `${stats.sent.length} new`,
    `${stats.skipped} unchanged`,
    `${stats.errors.length} errors`,
  ];
  if (stats.networkSkipped > 0) {
    parts.push(`${stats.networkSkipped} skipped (network unavailable)`);
  }
  printStdout(parts.join(", "));
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
    const channels = name
      ? configState.config.channels.filter(
          (entry) => toChannelNameKey(entry.name) === toChannelNameKey(name),
        )
      : configState.config.channels;

    const stats: CheckStats = { sent: [], skipped: 0, errors: [], networkSkipped: 0 };
    const limit = pLimit(Math.max(1, concurrency));
    const enqueueForChannel = createChannelQueue();
    const tasks: Array<Promise<void>> = [];
    const destinations = new Map<number, { destinationId: number; effectiveChannelUrl: string }>();

    for (const channelEntry of channels) {
      const effectiveChannelUrl = env.appriseUrlOverride ?? channelEntry.apprise_url;
      const destinationId = resolveDestinationId(db, buildDestinationKey(effectiveChannelUrl));
      destinations.set(destinationId, { destinationId, effectiveChannelUrl });
      backfillLegacyDeliveryKeys(db, destinationId, channelEntry.name);

      for (const subscription of channelEntry.subscriptions) {
        tasks.push(
          limit(async () => {
            await processSubscriptionCheck({
              channelName: channelEntry.name,
              effectiveChannelUrl,
              destinationId,
              subscription,
              db,
              dryRun,
              isJson,
              isVerbose,
              stats,
              enqueueForChannel,
              linkTransforms: configState.config.link_transforms,
            });
          }),
        );
      }
    }

    await Promise.all(tasks);
    if (!dryRun) {
      await Promise.all(
        [...destinations.values()].map(({ destinationId, effectiveChannelUrl }) =>
          enqueueForChannel(String(destinationId), () =>
            drainDestinationOutbox({
              db,
              destinationId,
              effectiveChannelUrl,
              isJson,
              isVerbose,
              stats,
            }),
          ),
        ),
      );
    }
    await flushArchivePool();
    printFinalSummary(stats, dryRun, isJson);
    return resolveExitCode(stats);
  } finally {
    sqlite.close();
  }
};
