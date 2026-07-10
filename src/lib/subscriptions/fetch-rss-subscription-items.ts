import { z } from "zod";
import { WachiError } from "../../utils/error.ts";
import type { WachiDb } from "../db/connect.ts";
import { getMetaValue } from "../db/get-meta-value.ts";
import { setMetaValue } from "../db/set-meta-value.ts";
import { http } from "../http/client.ts";
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

export const persistRssValidators = (
  db: WachiDb,
  rssUrl: string,
  validators: RssValidators,
  validatorScope?: string,
): void => {
  if (validators.etag) {
    setMetaValue(db, etagMetaKey(rssUrl, validatorScope), validators.etag);
  }
  if (validators.lastModified) {
    setMetaValue(db, lastModifiedMetaKey(rssUrl, validatorScope), validators.lastModified);
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

const buildSourceIdentity = async ({
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

export const fetchRssSubscriptionItems = async ({
  subscriptionUrl,
  rssUrl,
  db,
  useConditionalRequest = false,
  validatorScope,
}: FetchRssItemsOptions): Promise<FetchRssItemsResult> => {
  await waitForDomainRateLimit(rssUrl);

  const headers: Record<string, string> = {
    Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
  };

  if (useConditionalRequest && db) {
    const etag = getMetaValue(db, etagMetaKey(rssUrl, validatorScope));
    const lastModified = getMetaValue(db, lastModifiedMetaKey(rssUrl, validatorScope));
    if (etag) {
      headers["If-None-Match"] = etag;
    }
    if (lastModified) {
      headers["If-Modified-Since"] = lastModified;
    }
  }

  const response = await http.raw(rssUrl, {
    responseType: "text",
    headers,
    ignoreResponseError: true,
    timeout: RSS_FETCH_TIMEOUT_MS,
    retry: RSS_FETCH_RETRY_COUNT,
    retryDelay: RSS_FETCH_RETRY_DELAY_MS,
  });

  if (response.status === 304) {
    return {
      notModified: true,
      items: [],
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

  const xml = typeof response._data === "string" ? response._data : "";
  const parsed = await parseRssFeed(xml, rssUrl);
  const sourceIdentity = await buildSourceIdentity({
    subscriptionUrl,
    rssUrl,
    feedTitle: parsed.title,
    feedImageUrl: parsed.imageUrl,
    db,
  });

  return {
    notModified: false,
    items: parsed.items.map((item) => ({
      title: item.title,
      link: canonicalizeItemUrl(item.link, rssUrl) ?? item.link,
      publishedAt: item.publishedAt,
    })),
    sourceIdentity,
    validators: {
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
    },
  };
};
