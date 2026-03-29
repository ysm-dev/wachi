import { FetchError } from "ofetch";

/**
 * Returns true if the error is a network-level failure (no HTTP response received),
 * as opposed to an HTTP status error (4xx/5xx) where the server did respond.
 */
export const isNetworkLevelError = (error: unknown): boolean => {
  if (error instanceof FetchError) {
    return error.statusCode === undefined;
  }
  return false;
};

const NETWORK_AVAILABILITY_CACHE_MS = 10_000;

let lastNetworkAvailability: { checkedAt: number; available: boolean } | null = null;
let pendingNetworkAvailabilityCheck: Promise<boolean> | null = null;

export const resetNetworkAvailabilityStateForTest = (): void => {
  lastNetworkAvailability = null;
  pendingNetworkAvailabilityCheck = null;
};

/**
 * Probes external connectivity by making a lightweight HEAD request to a
 * well-known, highly-available host.  Returns `true` when the local machine
 * can reach the internet, `false` otherwise.
 *
 * This is intentionally kept simple: a single HEAD to 1.1.1.1 with a short
 * timeout.  The goal is to distinguish "my internet is down" from "the
 * target server is having issues".
 */
export const isNetworkAvailable = async (timeoutMs = 1_000): Promise<boolean> => {
  const now = Date.now();
  if (
    lastNetworkAvailability &&
    now - lastNetworkAvailability.checkedAt < NETWORK_AVAILABILITY_CACHE_MS
  ) {
    return lastNetworkAvailability.available;
  }

  if (!pendingNetworkAvailabilityCheck) {
    pendingNetworkAvailabilityCheck = (async () => {
      try {
        await fetch("https://1.1.1.1", {
          method: "HEAD",
          signal: AbortSignal.timeout(timeoutMs),
        });
        return true;
      } catch {
        return false;
      }
    })();
  }

  try {
    const available = await pendingNetworkAvailabilityCheck;
    lastNetworkAvailability = { checkedAt: Date.now(), available };
    return available;
  } finally {
    pendingNetworkAvailabilityCheck = null;
  }
};
