import { z } from "zod";
import { WachiError } from "../../utils/error.ts";
import type { WachiDb } from "../db/connect.ts";
import { getMetaValue } from "../db/get-meta-value.ts";
import { setMetaValue } from "../db/set-meta-value.ts";
import { http } from "../http/client.ts";
import { waitForDomainRateLimit } from "../http/rate-limit.ts";
import { parseRssItems } from "../rss/parse.ts";
import { resolveUrl } from "../url/resolve.ts";
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
});

export type FetchRssItemsResult = z.infer<typeof fetchRssItemsResultSchema>;

const etagMetaKey = (rssUrl: string): string => `etag:${rssUrl}`;
const lastModifiedMetaKey = (rssUrl: string): string => `last-modified:${rssUrl}`;

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
  const parsed = await parseRssItems(xml, subscriptionUrl);

  return {
    notModified: false,
    items: parsed.map((item) => ({
      title: item.title,
      link: resolveUrl(item.link, subscriptionUrl),
      publishedAt: item.publishedAt,
    })),
  };
};
