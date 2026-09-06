import { z } from "zod";
import type { WachiDb } from "../db/connect.ts";
import { countByHost, findOutagedHosts } from "./detect-host-outage.ts";
import { isRunOutageSuspected } from "./detect-run-outage.ts";
import { handleSubscriptionFailure, toFailureMessage } from "./handle-failure.ts";
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
 * 1. Transport requests across several hosts failed -> this machine has a problem.
 * 2. Every subscription behind one host failed -> that host has a problem.
 *
 * Runner-level transport failures are inconclusive and do not change subscription
 * health. HTTP, parsing, and failures isolated to one host remain actionable.
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

  const networkFailures = failures.filter((failure) => failure.networkLevel);
  const networkFailureHosts = new Set(
    networkFailures.map((failure) => new URL(failure.subscription.rss_url).hostname),
  );
  const outageSuspected = isRunOutageSuspected({
    totalSubscriptions,
    failureCount: networkFailures.length,
    failureHostCount: networkFailureHosts.size,
  });

  const outagedHosts = findOutagedHosts({
    attemptsByHost,
    failuresByHost: countByHost(failures.map((failure) => failure.subscription.rss_url)),
  });

  let suppressed = 0;

  for (const failure of failures) {
    if (outageSuspected && failure.networkLevel) {
      stats.networkSkipped += 1;
      stats.errors.push(`${failure.subscription.url}: ${toFailureMessage(failure.error)}`);
      suppressed += 1;
      continue;
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
    suppressed,
  };
};
