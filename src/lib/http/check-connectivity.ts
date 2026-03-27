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

/**
 * Probes external connectivity by making a lightweight HEAD request to a
 * well-known, highly-available host.  Returns `true` when the local machine
 * can reach the internet, `false` otherwise.
 *
 * This is intentionally kept simple: a single HEAD to 1.1.1.1 with a short
 * timeout.  The goal is to distinguish "my internet is down" from "the
 * target server is having issues".
 */
export const isNetworkAvailable = async (timeoutMs = 5_000): Promise<boolean> => {
  try {
    await fetch("https://1.1.1.1", {
      method: "HEAD",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return true;
  } catch {
    return false;
  }
};
