import { z } from "zod";
import type { WachiDb } from "../db/connect.ts";
import { isNetworkAvailable } from "../http/check-connectivity.ts";
import { countByHost, findOutagedHosts } from "./detect-host-outage.ts";
import { isRunOutageSuspected } from "./detect-run-outage.ts";
import { handleSubscriptionFailure } from "./handle-failure.ts";
import type { CheckStats } from "./handle-items.ts";
import type { PendingFailure } from "./process-subscription.ts";

const resolveFailuresOptionsSchema = z.object({
  failures: z.custom<PendingFailure[]>(),
  totalSubscriptions: z.number().int().nonnegative(),
  attemptsByHost: z.custom<ReadonlyMap<string, number>>(),
  db: z.custom<WachiDb>(),
  dryRun: z.boolean(),
  stats: z.custom<CheckStats>(),
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
 * Correlation is retained for the run summary, but every failure is recorded.
 * Missing an alert is worse than sending several alerts for one shared outage.
 */
export const resolveSubscriptionFailures = async ({
  failures,
  totalSubscriptions,
  attemptsByHost,
  db,
  dryRun,
  stats,
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

  const outageSuspected = isRunOutageSuspected({
    totalSubscriptions,
    failureCount: failures.length,
  });

  const outagedHosts = findOutagedHosts({
    attemptsByHost,
    failuresByHost: countByHost(failures.map((failure) => failure.subscription.rss_url)),
  });

  let networkAvailable: boolean | undefined;

  for (const failure of failures) {
    if (failure.networkLevel) {
      networkAvailable ??= await isNetworkAvailable();
      if (!networkAvailable) {
        stats.networkSkipped += 1;
      }
    }

    await handleSubscriptionFailure({
      channelName: failure.channelName,
      destinationId: failure.destinationId,
      subscription: failure.subscription,
      db,
      dryRun,
      stats,
      error: failure.error,
      attemptGeneration: failure.attemptGeneration,
    });
  }

  return {
    ...clean,
    outageSuspected,
    outagedHosts: [...outagedHosts].sort(),
    suppressed: 0,
  };
};
