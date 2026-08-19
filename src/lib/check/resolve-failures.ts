import { z } from "zod";
import type { WachiDb } from "../db/connect.ts";
import { isNetworkAvailable } from "../http/check-connectivity.ts";
import { countByHost, findOutagedHosts, toRssHost } from "./detect-host-outage.ts";
import { isRunOutageSuspected } from "./detect-run-outage.ts";
import { handleSubscriptionFailure, toFailureMessage } from "./handle-failure.ts";
import type { CheckStats } from "./handle-items.ts";
import type { PendingFailure } from "./process-subscription.ts";

type QueueFn = (channelUrl: string, task: () => Promise<void>) => Promise<void>;

const resolveFailuresOptionsSchema = z.object({
  failures: z.custom<PendingFailure[]>(),
  totalSubscriptions: z.number().int().nonnegative(),
  attemptsByHost: z.custom<ReadonlyMap<string, number>>(),
  db: z.custom<WachiDb>(),
  dryRun: z.boolean(),
  stats: z.custom<CheckStats>(),
  enqueueForChannel: z.custom<QueueFn>(),
});

type ResolveFailuresOptions = z.infer<typeof resolveFailuresOptionsSchema>;

export type ResolveFailuresResult = {
  outageSuspected: boolean;
  outagedHosts: string[];
  suppressed: number;
  total: number;
};

/**
 * Decides what to do with the failures collected during a run.
 *
 * Two correlations are checked, from coarsest to finest:
 *
 * 1. Most of the run failed -> this machine has a problem.
 * 2. Every subscription behind one host failed -> that host has a problem.
 *
 * In both cases the failures are recorded in the run summary but neither the
 * health counters nor the failure alerts are touched. One dead process must not
 * be able to burn down every dependent subscription's streak and fan alerts out
 * to every channel.
 *
 * Anything left over is handled individually, preserving the original behaviour
 * including the confirmed-network-down skip.
 */
export const resolveSubscriptionFailures = async ({
  failures,
  totalSubscriptions,
  attemptsByHost,
  db,
  dryRun,
  stats,
  enqueueForChannel,
}: ResolveFailuresOptions): Promise<ResolveFailuresResult> => {
  const clean: ResolveFailuresResult = {
    outageSuspected: false,
    outagedHosts: [],
    suppressed: 0,
    total: totalSubscriptions,
  };

  if (failures.length === 0) {
    return clean;
  }

  // Errors are still reported so the exit code and --json output stay truthful.
  // Only the durable failure counter and the notification are suppressed.
  const suppress = (failure: PendingFailure): void => {
    stats.errors.push(`${failure.subscription.url}: ${toFailureMessage(failure.error)}`);
  };

  if (isRunOutageSuspected({ totalSubscriptions, failureCount: failures.length })) {
    for (const failure of failures) {
      suppress(failure);
    }

    return { ...clean, outageSuspected: true, suppressed: failures.length };
  }

  const outagedHosts = findOutagedHosts({
    attemptsByHost,
    failuresByHost: countByHost(failures.map((failure) => failure.subscription.rss_url)),
  });

  let suppressed = 0;

  for (const failure of failures) {
    const host = toRssHost(failure.subscription.rss_url);
    if (host && outagedHosts.has(host)) {
      suppress(failure);
      suppressed += 1;
      continue;
    }

    if (failure.networkLevel && !(await isNetworkAvailable())) {
      stats.networkSkipped += 1;
      continue;
    }

    await handleSubscriptionFailure({
      channelName: failure.channelName,
      effectiveChannelUrl: failure.effectiveChannelUrl,
      subscription: failure.subscription,
      db,
      dryRun,
      stats,
      enqueueForChannel,
      error: failure.error,
    });
  }

  return { ...clean, outagedHosts: [...outagedHosts].sort(), suppressed };
};
