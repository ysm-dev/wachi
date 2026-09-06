import { FetchError } from "ofetch";

export type NetworkFailureKind = "dns" | "connect" | "tls" | "timeout";

export class NetworkLevelError extends Error {
  readonly kind: NetworkFailureKind;

  constructor(kind: NetworkFailureKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NetworkLevelError";
    this.kind = kind;
  }
}

/**
 * Returns true if the error is a network-level failure (no HTTP response received),
 * as opposed to an HTTP status error (4xx/5xx) where the server did respond.
 */
export const isNetworkLevelError = (error: unknown): boolean => {
  if (error instanceof NetworkLevelError) {
    return true;
  }
  if (error instanceof FetchError) {
    return error.statusCode === undefined;
  }
  return false;
};
