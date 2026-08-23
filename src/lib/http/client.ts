import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { ofetch } from "ofetch";
import { VERSION } from "../../version.ts";
import {
  isSafeDiscoveredHttpUrl,
  resolveSafeHttpAddresses,
  type SafeResolvedAddress,
} from "../url/network-policy.ts";

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

const requestPinned = async (
  url: string,
  addresses: SafeResolvedAddress[],
  headers: HeadersInit | undefined,
  signal: AbortSignal,
): Promise<Response> => {
  const parsedUrl = new URL(url);
  const requestHeaders = new Headers(headers);
  requestHeaders.set("User-Agent", `wachi/${VERSION}`);
  requestHeaders.set("Accept-Encoding", "gzip, deflate, br");

  return new Promise<Response>((resolve, reject) => {
    const request = (parsedUrl.protocol === "https:" ? requestHttps : requestHttp)(
      parsedUrl,
      {
        headers: Object.fromEntries(requestHeaders.entries()),
        signal,
        lookup: (_hostname, options, callback) => {
          if (typeof options !== "number" && options.all) {
            const reply = callback as (
              error: null,
              resolved: Array<{ address: string; family: number }>,
            ) => void;
            reply(null, addresses);
            return;
          }
          const selected = addresses[0];
          if (!selected) {
            const reply = callback as (error: Error) => void;
            reply(new Error("No validated address is available."));
            return;
          }
          const reply = callback as (error: null, address: string, family: number) => void;
          reply(null, selected.address, selected.family);
        },
      },
      (incoming) => {
        const hasBody = incoming.statusCode !== 204 && incoming.statusCode !== 304;
        let body: Readable = incoming;
        const contentEncoding = incoming.headers["content-encoding"]?.toLowerCase();
        if (hasBody && contentEncoding === "gzip") {
          body = incoming.pipe(createGunzip());
        } else if (hasBody && contentEncoding === "deflate") {
          body = incoming.pipe(createInflate());
        } else if (hasBody && contentEncoding === "br") {
          body = incoming.pipe(createBrotliDecompress());
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
    request.once("error", reject);
    request.end();
  });
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
      const resolvedAddresses = await resolveSafeHttpAddresses(
        currentUrl,
        requestedUrl,
        undefined,
        controller.signal,
      );
      if (!resolvedAddresses) {
        throw new Error(`Unsafe URL blocked while fetching ${requestedUrl}.`);
      }
      const response = await requestPinned(
        currentUrl,
        resolvedAddresses,
        headers,
        controller.signal,
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
  } finally {
    clearTimeout(timeout);
  }
};
