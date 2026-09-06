import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { pipeline, Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { ofetch } from "ofetch";
import { VERSION } from "../../version.ts";
import {
  isSafeDiscoveredHttpUrl,
  resolveSafeHttpAddresses,
  type SafeResolvedAddress,
} from "../url/network-policy.ts";
import { type NetworkFailureKind, NetworkLevelError } from "./check-connectivity.ts";

export const http = ofetch.create({
  timeout: 30_000,
  retry: 3,
  retryDelay: 1_000,
  retryStatusCodes: [408, 429, 500, 502, 503, 504],
  headers: {
    "User-Agent": `wachi/${VERSION}`,
  },
});

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_REDIRECTS = 5;

const toConnectionFailureKind = (error: unknown): NetworkFailureKind => {
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  if (
    code.startsWith("ERR_TLS_") ||
    code.startsWith("CERT_") ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  ) {
    return "tls";
  }
  if (code === "ETIMEDOUT" || (error instanceof Error && error.message.startsWith("Timed out"))) {
    return "timeout";
  }
  return "connect";
};

export type BoundedTextResponse = {
  status: number;
  statusText: string;
  headers: Headers;
  url: string;
  body: string;
};

type FetchBoundedTextOptions = {
  headers?: HeadersInit;
  timeoutMs: number;
  maxBytes: number;
  retry?: number;
  retryDelayMs?: number;
  retryStatusCodes?: number[];
};

const cancelResponseBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {}
};

const readBoundedBody = async (response: Response, maxBytes: number): Promise<string> => {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(`Response body exceeds the ${maxBytes}-byte limit.`);
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
};

const requestPinnedAddress = async (
  url: string,
  address: SafeResolvedAddress,
  headers: HeadersInit | undefined,
  signal: AbortSignal,
  connectionTimeoutMs: number,
): Promise<Response> => {
  const parsedUrl = new URL(url);
  // Bun 1.3.10 loses TLS hostname context when https.request uses a custom
  // lookup. Connect to the validated IP directly while preserving Host/SNI.
  const tlsHostname = parsedUrl.hostname.replace(/^\[(.*)\]$/, "$1");
  const requestHeaders = new Headers(headers);
  requestHeaders.set("User-Agent", `wachi/${VERSION}`);
  requestHeaders.set("Accept-Encoding", "gzip, deflate, br");
  requestHeaders.set("Connection", "close");
  // Bun 1.3.10 incorrectly includes a non-default HTTPS port in certificate
  // hostname verification, so keep the TLS Host header port-free.
  requestHeaders.set("Host", parsedUrl.protocol === "https:" ? parsedUrl.hostname : parsedUrl.host);

  return new Promise<Response>((resolve, reject) => {
    let connectionTimeout: ReturnType<typeof setTimeout>;
    const clearConnectionTimeout = () => clearTimeout(connectionTimeout);
    const request = (parsedUrl.protocol === "https:" ? requestHttps : requestHttp)(
      {
        hostname: address.address,
        port: parsedUrl.port || undefined,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        headers: Object.fromEntries(requestHeaders.entries()),
        agent: false,
        signal,
        servername: tlsHostname,
      },
      (incoming) => {
        clearConnectionTimeout();
        const hasBody = incoming.statusCode !== 204 && incoming.statusCode !== 304;
        let body: Readable = incoming;
        const contentEncoding = incoming.headers["content-encoding"]?.toLowerCase();
        if (hasBody && contentEncoding === "gzip") {
          const decoder = createGunzip();
          body = decoder;
          pipeline(incoming, decoder, () => {});
        } else if (hasBody && contentEncoding === "deflate") {
          const decoder = createInflate();
          body = decoder;
          pipeline(incoming, decoder, () => {});
        } else if (hasBody && contentEncoding === "br") {
          const decoder = createBrotliDecompress();
          body = decoder;
          pipeline(incoming, decoder, () => {});
        }

        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const entry of value) {
              responseHeaders.append(name, entry);
            }
          } else if (value !== undefined) {
            responseHeaders.set(name, value);
          }
        }
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("content-length");
        if (!hasBody) {
          incoming.resume();
        }
        const responseBody = hasBody
          ? (Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>)
          : null;
        resolve(
          new Response(responseBody, {
            status: incoming.statusCode ?? 500,
            statusText: incoming.statusMessage,
            headers: responseHeaders,
          }),
        );
      },
    );
    connectionTimeout = setTimeout(() => {
      request.destroy(new Error(`Timed out connecting to ${address.address}.`));
    }, connectionTimeoutMs);
    request.once("error", (error) => {
      clearConnectionTimeout();
      reject(error);
    });
    request.end();
  });
};

const requestPinned = async (
  url: string,
  addresses: SafeResolvedAddress[],
  headers: HeadersInit | undefined,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Response> => {
  let lastError: unknown;
  const addressTimeoutMs = Math.max(250, Math.floor(timeoutMs / addresses.length));
  for (const address of addresses) {
    try {
      return await requestPinnedAddress(url, address, headers, signal, addressTimeoutMs);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      lastError = error;
    }
  }
  const error = lastError ?? new Error("No validated address is available.");
  throw new NetworkLevelError(
    toConnectionFailureKind(error),
    error instanceof Error ? error.message : "Failed to connect to the feed host.",
    { cause: error },
  );
};

const waitForRetryDelay = async (delayMs: number, signal: AbortSignal): Promise<void> => {
  if (delayMs <= 0) {
    return;
  }
  if (signal.aborted) {
    throw signal.reason;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

export const fetchBoundedText = async (
  requestedUrl: string,
  {
    headers,
    timeoutMs,
    maxBytes,
    retry = 3,
    retryDelayMs = 1_000,
    retryStatusCodes,
  }: FetchBoundedTextOptions,
): Promise<BoundedTextResponse> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const allowedRetryStatuses = retryStatusCodes
    ? new Set(retryStatusCodes)
    : DEFAULT_RETRY_STATUSES;

  let currentUrl = requestedUrl;
  let redirects = 0;
  let remainingRetries = retry;

  try {
    while (true) {
      let resolvedAddresses: SafeResolvedAddress[] | null;
      try {
        resolvedAddresses = await resolveSafeHttpAddresses(
          currentUrl,
          requestedUrl,
          undefined,
          controller.signal,
          true,
        );
      } catch (error) {
        const timedOut = controller.signal.aborted;
        throw new NetworkLevelError(
          timedOut ? "timeout" : "dns",
          timedOut
            ? `Timed out resolving ${new URL(currentUrl).hostname}.`
            : `DNS lookup failed for ${new URL(currentUrl).hostname}: ${error instanceof Error ? error.message : "unknown error"}`,
          { cause: error },
        );
      }
      if (!resolvedAddresses) {
        throw new Error(`Unsafe URL blocked while fetching ${requestedUrl}.`);
      }
      const response = await requestPinned(
        currentUrl,
        resolvedAddresses,
        headers,
        controller.signal,
        timeoutMs,
      );

      if (allowedRetryStatuses.has(response.status) && remainingRetries > 0) {
        remainingRetries -= 1;
        await cancelResponseBody(response);
        await waitForRetryDelay(retryDelayMs, controller.signal);
        continue;
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        if (location) {
          if (redirects >= MAX_REDIRECTS) {
            await cancelResponseBody(response);
            throw new Error(`Too many redirects while fetching ${requestedUrl}.`);
          }

          const redirectUrl = new URL(location, currentUrl).toString();
          if (!isSafeDiscoveredHttpUrl(redirectUrl, requestedUrl)) {
            await cancelResponseBody(response);
            throw new Error(`Unsafe redirect blocked while fetching ${requestedUrl}.`);
          }

          redirects += 1;
          currentUrl = redirectUrl;
          await cancelResponseBody(response);
          continue;
        }
      }

      const effectiveUrl = currentUrl;
      if (!isSafeDiscoveredHttpUrl(effectiveUrl, requestedUrl)) {
        await cancelResponseBody(response);
        throw new Error(`Unsafe redirect blocked while fetching ${requestedUrl}.`);
      }

      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        url: effectiveUrl,
        body: await readBoundedBody(response, maxBytes),
      };
    }
  } catch (error) {
    if (error instanceof NetworkLevelError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new NetworkLevelError("timeout", `Timed out fetching ${requestedUrl}.`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};
