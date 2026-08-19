/**
 * Minimum number of subscriptions behind a host before its failures are treated
 * as a host outage. Below this, "every subscription on the host failed" is not
 * distinguishable from "the one feed on that host is broken".
 */
export const HOST_OUTAGE_MIN_SUBSCRIPTIONS = 3;

/**
 * Groups subscriptions by the origin that actually serves the feed.
 *
 * The port is part of the key on purpose: a self-hosted setup routinely runs
 * several unrelated feed services on localhost (RSSHub on :1200, torss on :8677),
 * and one dying must not implicate the other.
 */
export const toRssHost = (rssUrl: string): string | null => {
  try {
    return new URL(rssUrl).host || null;
  } catch {
    return null;
  }
};

export const countByHost = (rssUrls: Array<string | null>): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const rssUrl of rssUrls) {
    const host = rssUrl === null ? null : toRssHost(rssUrl);
    if (!host) {
      continue;
    }
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return counts;
};

/**
 * Returns the hosts whose subscriptions all failed in this run.
 *
 * A shared backend is a single point of failure for every subscription behind it.
 * When it goes down, those subscriptions do not represent N broken feeds spread
 * across N channels; they represent one process that is not running. Alerting per
 * subscription turns one incident into a channel-wide flood, and incrementing the
 * counters burns down every streak at once.
 *
 * Requiring *all* of a host's subscriptions to fail keeps this from hiding real
 * breakage: one dead route on a healthy host still fails alone and still alerts.
 */
export const findOutagedHosts = ({
  attemptsByHost,
  failuresByHost,
}: {
  attemptsByHost: ReadonlyMap<string, number>;
  failuresByHost: ReadonlyMap<string, number>;
}): Set<string> => {
  const outagedHosts = new Set<string>();

  for (const [host, attempts] of attemptsByHost) {
    if (attempts < HOST_OUTAGE_MIN_SUBSCRIPTIONS) {
      continue;
    }
    if ((failuresByHost.get(host) ?? 0) >= attempts) {
      outagedHosts.add(host);
    }
  }

  return outagedHosts;
};
