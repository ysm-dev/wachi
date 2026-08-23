import { z } from "zod";
import { WachiError } from "../../utils/error.ts";
import type { WachiDb } from "../db/connect.ts";
import { deleteMetaValue } from "../db/delete-meta-value.ts";
import { getMetaValue } from "../db/get-meta-value.ts";
import { setMetaValue } from "../db/set-meta-value.ts";
import { fetchBoundedText } from "../http/client.ts";
import { waitForDomainRateLimit } from "../http/rate-limit.ts";
import type { SourceIdentity } from "../notify/source-identity.ts";
import { parseRssFeed } from "../rss/parse.ts";
import { canonicalizeItemUrl } from "../url/canonicalize-item-url.ts";
import { loadWebsiteBranding } from "./load-website-branding.ts";
import { fallbackWebsiteTitle, googleS2FaviconUrl } from "./source-branding.ts";
import { subscriptionItemSchema } from "./subscription-item.ts";

const RSS_FETCH_TIMEOUT_MS = 5_000;
const RSS_FETCH_RETRY_COUNT = 1;
const RSS_FETCH_RETRY_DELAY_MS = 250;
const RSS_FETCH_MAX_BYTES = 5 * 1024 * 1024;

const fetchRssItemsOptionsSchema = z.object({
  subscriptionUrl: z.string(),
  rssUrl: z.string(),
  db: z.custom<WachiDb>().optional(),
  useConditionalRequest: z.boolean().optional(),
  validatorScope: z.string().optional(),
});

type FetchRssItemsOptions = z.infer<typeof fetchRssItemsOptionsSchema>;

const fetchRssItemsResultSchema = z.object({
  notModified: z.boolean(),
  items: z.array(subscriptionItemSchema),
  sourceIdentity: z
    .object({
      username: z.string().optional(),
      avatarUrl: z.string().url().optional(),
    })
    .optional(),
  validators: z.object({
    etag: z.string().nullable(),
    lastModified: z.string().nullable(),
  }),
});

export type FetchRssItemsResult = z.infer<typeof fetchRssItemsResultSchema>;

export type FetchedRssDocument = {
  notModified: boolean;
  items: FetchRssItemsResult["items"];
  feedUrl: string;
  feedTitle: string | null;
  feedImageUrl: string | null;
  validators: RssValidators;
};

const validatorKey = (rssUrl: string, validatorScope?: string): string => {
  return validatorScope ? `${validatorScope}:${rssUrl}` : rssUrl;
};

const etagMetaKey = (rssUrl: string, validatorScope?: string): string =>
  `etag:${validatorKey(rssUrl, validatorScope)}`;
const lastModifiedMetaKey = (rssUrl: string, validatorScope?: string): string =>
  `last-modified:${validatorKey(rssUrl, validatorScope)}`;

export type RssValidators = {
  etag: string | null;
  lastModified: string | null;
};

export const readRssValidators = (
  db: WachiDb,
  rssUrl: string,
  validatorScope?: string,
): RssValidators => ({
  etag: getMetaValue(db, etagMetaKey(rssUrl, validatorScope)),
  lastModified: getMetaValue(db, lastModifiedMetaKey(rssUrl, validatorScope)),
});

export const persistRssValidators = (
  db: WachiDb,
  rssUrl: string,
  validators: RssValidators,
  validatorScope?: string,
  clearMissing = true,
): void => {
  if (validators.etag) {
    setMetaValue(db, etagMetaKey(rssUrl, validatorScope), validators.etag);
  } else if (clearMissing) {
    deleteMetaValue(db, etagMetaKey(rssUrl, validatorScope));
  }
  if (validators.lastModified) {
    setMetaValue(db, lastModifiedMetaKey(rssUrl, validatorScope), validators.lastModified);
  } else if (clearMissing) {
    deleteMetaValue(db, lastModifiedMetaKey(rssUrl, validatorScope));
  }
};

const resolveOptionalHttpUrl = (value: string | null, baseUrl: string): string | null => {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value, baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

export const resolveRssSourceIdentity = async ({
  subscriptionUrl,
  rssUrl,
  feedTitle,
  feedImageUrl,
  db,
}: {
  subscriptionUrl: string;
  rssUrl: string;
  feedTitle: string | null;
  feedImageUrl: string | null;
  db?: WachiDb;
}): Promise<SourceIdentity> => {
  let websiteTitle: string | null = null;
  let websiteFaviconUrl: string | null = null;
  const resolvedFeedImageUrl = resolveOptionalHttpUrl(feedImageUrl, rssUrl);
  const originalLinkFaviconUrl = googleS2FaviconUrl(subscriptionUrl);

  if (!feedTitle || (!resolvedFeedImageUrl && !originalLinkFaviconUrl)) {
    const websiteBranding = await loadWebsiteBranding(subscriptionUrl, db);
    websiteTitle = websiteBranding.title;
    websiteFaviconUrl = websiteBranding.faviconUrl;
  }

  const username = feedTitle ?? websiteTitle ?? fallbackWebsiteTitle(subscriptionUrl) ?? undefined;
  const avatarUrl =
    resolvedFeedImageUrl ?? originalLinkFaviconUrl ?? websiteFaviconUrl ?? undefined;

  return { username, avatarUrl };
};

export const fetchRssDocument = async ({
  rssUrl,
  requestValidators,
  rateLimitAcquired = false,
}: {
  rssUrl: string;
  requestValidators?: RssValidators;
  rateLimitAcquired?: boolean;
}): Promise<FetchedRssDocument> => {
  if (!rateLimitAcquired) {
    await waitForDomainRateLimit(rssUrl);
  }

  const headers: Record<string, string> = {
    Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
  };
  if (requestValidators?.etag) {
    headers["If-None-Match"] = requestValidators.etag;
  }
  if (requestValidators?.lastModified) {
    headers["If-Modified-Since"] = requestValidators.lastModified;
  }

  const response = await fetchBoundedText(rssUrl, {
    headers,
    timeoutMs: RSS_FETCH_TIMEOUT_MS,
    maxBytes: RSS_FETCH_MAX_BYTES,
    retry: RSS_FETCH_RETRY_COUNT,
    retryDelayMs: RSS_FETCH_RETRY_DELAY_MS,
  });

  if (response.status === 304) {
    if (!requestValidators?.etag && !requestValidators?.lastModified) {
      throw new WachiError(
        `Failed to fetch ${rssUrl}`,
        "The server returned 304 Not Modified without a conditional request.",
        "Try again later or verify the feed URL.",
      );
    }
    return {
      notModified: true,
      items: [],
      feedUrl: response.url,
      feedTitle: null,
      feedImageUrl: null,
      validators: {
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
      },
    };
  }

  if (response.status >= 400) {
    throw new WachiError(
      `Failed to fetch ${rssUrl}`,
      `HTTP ${response.status} ${response.statusText}. The server rejected the request.`,
      "The site may be blocking automated requests. Try again later or verify the URL.",
    );
  }

  const parsed = await parseRssFeed(response.body, response.url);
  return {
    notModified: false,
    feedUrl: response.url,
    items: parsed.items.flatMap((item) => {
      const link = canonicalizeItemUrl(item.link, response.url);
      const parsedItem = subscriptionItemSchema.safeParse({ ...item, link });
      return parsedItem.success ? [parsedItem.data] : [];
    }),
    feedTitle: parsed.title,
    feedImageUrl: parsed.imageUrl,
    validators: {
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
    },
  };
};

export const fetchRssSubscriptionItems = async ({
  subscriptionUrl,
  rssUrl,
  db,
  useConditionalRequest = false,
  validatorScope,
}: FetchRssItemsOptions): Promise<FetchRssItemsResult> => {
  const requestValidators =
    useConditionalRequest && db ? readRssValidators(db, rssUrl, validatorScope) : undefined;
  const document = await fetchRssDocument({ rssUrl, requestValidators });
  if (document.notModified) {
    return {
      notModified: true,
      items: [],
      validators: document.validators,
    };
  }

  const sourceIdentity = await resolveRssSourceIdentity({
    subscriptionUrl,
    rssUrl: document.feedUrl,
    feedTitle: document.feedTitle,
    feedImageUrl: document.feedImageUrl,
    db,
  });

  return {
    notModified: false,
    items: document.items,
    sourceIdentity,
    validators: document.validators,
  };
};
