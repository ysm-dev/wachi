import { z } from "zod";

/**
 * Minimum number of subscriptions attempted in a run before the failure ratio
 * is considered meaningful. Below this, a run is too small to distinguish a
 * local outage from a handful of genuinely broken feeds.
 */
export const OUTAGE_MIN_SUBSCRIPTIONS = 5;

/**
 * Fraction of attempted subscriptions that must fail before the run is treated
 * as an environment problem rather than a set of per-feed problems.
 */
export const OUTAGE_FAILURE_RATIO = 0.5;

const runOutageInputSchema = z.object({
  totalSubscriptions: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
});

type RunOutageInput = z.infer<typeof runOutageInputSchema>;

/**
 * Returns true when a large fraction of the subscriptions attempted in a single
 * run failed, which is far stronger evidence of a local/network problem than any
 * per-request error classification can provide.
 *
 * Independent hosts do not fail together. When they appear to, the common factor
 * is the machine running the check: broken DNS, a captive portal, a saturated
 * uplink, or a VPN. None of those are reliably detectable from a single error.
 */
export const isRunOutageSuspected = ({
  totalSubscriptions,
  failureCount,
}: RunOutageInput): boolean => {
  if (totalSubscriptions < OUTAGE_MIN_SUBSCRIPTIONS) {
    return false;
  }

  return failureCount / totalSubscriptions >= OUTAGE_FAILURE_RATIO;
};
