import pLimit from "p-limit";
import { z } from "zod";
import { getEnv } from "../../utils/env.ts";
import { flushArchivePool } from "../archive/pool.ts";
import { printJsonSuccess, printStdout } from "../cli/io.ts";
import { toChannelNameKey } from "../config/channel-name-key.ts";
import { readConfig } from "../config/read.ts";
import type { SubscriptionConfig } from "../config/schema.ts";
import { connectDb } from "../db/connect.ts";
import { resolveDestinationId } from "../db/delivery-ledger.ts";
import { buildDestinationKey } from "../notify/destination-identity.ts";
import { backfillLegacyDeliveryKeys, hasDeliveryCutover } from "./delivery-cutover.ts";
import { countByHost } from "./detect-host-outage.ts";
import { drainDestinationOutbox } from "./drain-outbox.ts";
import type { CheckStats } from "./handle-items.ts";
import { type PendingFailure, processSubscriptionCheck } from "./process-subscription.ts";
import { type ResolveFailuresResult, resolveSubscriptionFailures } from "./resolve-failures.ts";
import { runRateLimitedChecks } from "./run-rate-limited-checks.ts";
import { createSharedRssFetcher, resolveSharedRssValidators } from "./shared-rss-fetch.ts";

const runCheckOptionsSchema = z.object({
  name: z.string().optional(),
  concurrency: z.number(),
  dryRun: z.boolean(),
  isJson: z.boolean(),
  isVerbose: z.boolean(),
  configPath: z.string().optional(),
});

type RunCheckOptions = z.infer<typeof runCheckOptionsSchema>;

type SubscriptionTarget = {
  channelName: string;
  effectiveChannelUrl: string;
  destinationId: number;
  subscription: SubscriptionConfig;
  cutoverComplete: boolean;
};

type FeedGroup = {
  targetUrl: string;
  targets: SubscriptionTarget[];
};

export const MAX_CONCURRENT_DESTINATION_DRAINS = 4;

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

const printFinalSummary = (
  stats: CheckStats,
  dryRun: boolean,
  isJson: boolean,
  outage: ResolveFailuresResult,
): void => {
  if (isJson) {
    printJsonSuccess({
      sent: stats.sent,
      skipped: stats.skipped,
      errors: stats.errors,
      network_skipped: stats.networkSkipped,
      outage_suspected: outage.outageSuspected,
      outaged_hosts: outage.outagedHosts,
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

  if (outage.outageSuspected) {
    printStdout(
      `Most subscriptions failed this run (${outage.suppressed}/${outage.total}). ` +
        "Assuming a local network problem: failure counters and alerts were not updated.",
    );
    return;
  }

  if (outage.outagedHosts.length > 0) {
    printStdout(
      `Every subscription on ${outage.outagedHosts.join(", ")} failed this run ` +
        `(${outage.suppressed} total). Assuming the host is down: ` +
        "failure counters and alerts were not updated.",
    );
  }
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
    const enqueueForChannel = createChannelQueue();
    const failures: PendingFailure[] = [];
    const attemptedRssUrls: string[] = [];
    const destinations = new Map<number, { destinationId: number; effectiveChannelUrl: string }>();
    const feedGroups = new Map<string, FeedGroup>();

    for (const channelEntry of channels) {
      const effectiveChannelUrl = env.appriseUrlOverride ?? channelEntry.apprise_url;
      const destinationId = resolveDestinationId(db, buildDestinationKey(effectiveChannelUrl));
      destinations.set(destinationId, { destinationId, effectiveChannelUrl });
      backfillLegacyDeliveryKeys(db, destinationId, channelEntry.name);

      for (const subscription of channelEntry.subscriptions) {
        attemptedRssUrls.push(subscription.rss_url);
        const group = feedGroups.get(subscription.rss_url) ?? {
          targetUrl: subscription.rss_url,
          targets: [],
        };
        group.targets.push({
          channelName: channelEntry.name,
          effectiveChannelUrl,
          destinationId,
          subscription,
          cutoverComplete: hasDeliveryCutover(db, destinationId, subscription.rss_url),
        });
        feedGroups.set(subscription.rss_url, group);
      }
    }

    await runRateLimitedChecks([...feedGroups.values()], concurrency, async (group) => {
      const requestValidators = resolveSharedRssValidators(db, group.targetUrl, group.targets);
      const fetchItems = createSharedRssFetcher({
        db,
        rssUrl: group.targetUrl,
        requestValidators,
        rateLimitAcquired: true,
      });

      for (const target of group.targets) {
        await processSubscriptionCheck({
          channelName: target.channelName,
          effectiveChannelUrl: target.effectiveChannelUrl,
          destinationId: target.destinationId,
          subscription: target.subscription,
          db,
          dryRun,
          isJson,
          isVerbose,
          stats,
          failures,
          linkTransforms: configState.config.link_transforms,
          cutoverComplete: target.cutoverComplete,
          fetchItems: () => fetchItems(target.subscription.url),
        });
      }
    });
    const outage = await resolveSubscriptionFailures({
      failures,
      totalSubscriptions: attemptedRssUrls.length,
      attemptsByHost: countByHost(attemptedRssUrls),
      db,
      dryRun,
      stats,
      enqueueForChannel,
    });

    if (!dryRun) {
      const deliveryLimit = pLimit(MAX_CONCURRENT_DESTINATION_DRAINS);
      await Promise.all(
        [...destinations.values()].map(({ destinationId, effectiveChannelUrl }) =>
          deliveryLimit(() =>
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
        ),
      );
    }
    await flushArchivePool();
    printFinalSummary(stats, dryRun, isJson, outage);
    return resolveExitCode(stats);
  } finally {
    sqlite.close();
  }
};
