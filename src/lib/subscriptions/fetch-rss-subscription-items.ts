import { z } from "zod";
import { WachiError } from "../../utils/error.ts";
import type { WachiDb } from "../db/connect.ts";
import { getMetaValue } from "../db/get-meta-value.ts";
import { setMetaValue } from "../db/set-meta-value.ts";
import { http } from "../http/client.ts";
import { waitForDomainRateLimit } from "../http/rate-limit.ts";
import type { SourceIdentity } from "../notify/source-identity.ts";
import { parseRssFeed } from "../rss/parse.ts";
import { resolveUrl } from "../url/resolve.ts";
import {
  extractWebsiteBranding,
  fallbackWebsiteFaviconUrl,
  fallbackWebsiteTitle,
  googleS2FaviconUrl,
} from "./source-branding.ts";
import { subscriptionItemSchema } from "./subscription-item.ts";

const fetchRssItemsOptionsSchema = z.object({
  subscriptionUrl: z.string(),
  rssUrl: z.string(),
  db: z.custom<WachiDb>().optional(),
  useConditionalRequest: z.boolean().optional(),
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
});

export type FetchRssItemsResult = z.infer<typeof fetchRssItemsResultSchema>;

const etagMetaKey = (rssUrl: string): string => `etag:${rssUrl}`;
const lastModifiedMetaKey = (rssUrl: string): string => `last-modified:${rssUrl}`;

const fetchWebsiteBranding = async (subscriptionUrl: string) => {
  try {
    await waitForDomainRateLimit(subscriptionUrl);
    const response = await http.raw(subscriptionUrl, {
      responseType: "text",
      ignoreResponseError: true,
    });
    if (response.status >= 400) {
      return { title: null, faviconUrl: null };
    }
    const html = typeof response._data === "string" ? response._data : "";
    return extractWebsiteBranding(subscriptionUrl, html);
  } catch {
    return { title: null, faviconUrl: null };
  }
};

const resolveOptionalUrl = (value: string | null, baseUrl: string): string | null => {
  if (!value) {
    return null;
  }

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
};

const buildSourceIdentity = async ({
  subscriptionUrl,
  rssUrl,
  feedTitle,
  feedImageUrl,
}: {
  subscriptionUrl: string;
  rssUrl: string;
  feedTitle: string | null;
  feedImageUrl: string | null;
}): Promise<SourceIdentity> => {
  let websiteTitle: string | null = null;
  let websiteFaviconUrl: string | null = null;

  if (!feedTitle || !feedImageUrl) {
    const websiteBranding = await fetchWebsiteBranding(subscriptionUrl);
    websiteTitle = websiteBranding.title;
    websiteFaviconUrl = websiteBranding.faviconUrl;
  }

  const username = feedTitle ?? websiteTitle ?? fallbackWebsiteTitle(subscriptionUrl) ?? undefined;
  const resolvedFeedImageUrl = resolveOptionalUrl(feedImageUrl, rssUrl);
  const avatarUrl =
    resolvedFeedImageUrl ??
    websiteFaviconUrl ??
    fallbackWebsiteFaviconUrl(subscriptionUrl) ??
    googleS2FaviconUrl(subscriptionUrl) ??
    undefined;

  return { username, avatarUrl };
};

export const fetchRssSubscriptionItems = async ({
  subscriptionUrl,
  rssUrl,
  db,
  useConditionalRequest = false,
}: FetchRssItemsOptions): Promise<FetchRssItemsResult> => {
  await waitForDomainRateLimit(rssUrl);

  const headers: Record<string, string> = {
    Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
  };

  if (useConditionalRequest && db) {
    const etag = getMetaValue(db, etagMetaKey(rssUrl));
    const lastModified = getMetaValue(db, lastModifiedMetaKey(rssUrl));
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
  });

  if (response.status === 304) {
    return { notModified: true, items: [] };
  }

  if (response.status >= 400) {
    throw new WachiError(
      `Failed to fetch ${rssUrl}`,
      `HTTP ${response.status} ${response.statusText}. The server rejected the request.`,
      "The site may be blocking automated requests. Try again later or verify the URL.",
    );
  }

  if (db) {
    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");
    if (etag) {
      setMetaValue(db, etagMetaKey(rssUrl), etag);
    }
    if (lastModified) {
      setMetaValue(db, lastModifiedMetaKey(rssUrl), lastModified);
    }
  }

  const xml = typeof response._data === "string" ? response._data : "";
  const parsed = await parseRssFeed(xml, subscriptionUrl);
  const sourceIdentity = await buildSourceIdentity({
    subscriptionUrl,
    rssUrl,
    feedTitle: parsed.title,
    feedImageUrl: parsed.imageUrl,
  });

  return {
    notModified: false,
    items: parsed.items.map((item) => ({
      title: item.title,
      link: resolveUrl(item.link, subscriptionUrl),
      publishedAt: item.publishedAt,
    })),
    sourceIdentity,
  };
};
