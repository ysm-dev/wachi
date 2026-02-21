import Parser from "rss-parser";
import { z } from "zod";

const parsedFeedItemSchema = z.object({
  title: z.string(),
  link: z.string(),
  publishedAt: z.string().nullable(),
});

export type ParsedFeedItem = z.infer<typeof parsedFeedItemSchema>;

const parsedFeedSchema = z.object({
  title: z.string().nullable(),
  siteUrl: z.string().nullable(),
  imageUrl: z.string().nullable(),
  items: z.array(parsedFeedItemSchema),
});

export type ParsedFeed = z.infer<typeof parsedFeedSchema>;

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
};

const asCleanString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const extractFeedImageUrl = (feed: unknown): string | null => {
  const feedRecord = asRecord(feed);
  if (!feedRecord) {
    return null;
  }

  const feedImage = asRecord(feedRecord.image);
  const feedImageUrl = asCleanString(feedImage?.url);
  if (feedImageUrl) {
    return feedImageUrl;
  }

  const itunesImage = feedRecord["itunes:image"];
  const itunesImageUrl = asCleanString(itunesImage);
  if (itunesImageUrl) {
    return itunesImageUrl;
  }

  const itunesImageRecord = asRecord(itunesImage);
  const attrHref = asCleanString(itunesImageRecord?.href);
  if (attrHref) {
    return attrHref;
  }

  const attrRecord = asRecord(itunesImageRecord?.$);
  const xmlHref = asCleanString(attrRecord?.href);
  if (xmlHref) {
    return xmlHref;
  }

  const itunesRecord = asRecord(feedRecord.itunes);
  const nestedItunesImage = itunesRecord?.image;
  const nestedItunesImageUrl = asCleanString(nestedItunesImage);
  if (nestedItunesImageUrl) {
    return nestedItunesImageUrl;
  }

  const nestedItunesImageRecord = asRecord(nestedItunesImage);
  return asCleanString(nestedItunesImageRecord?.href);
};

const extractFeedSiteUrl = (feed: unknown): string | null => {
  const feedRecord = asRecord(feed);
  if (!feedRecord) {
    return null;
  }

  return asCleanString(feedRecord.link);
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

const parseDate = (value: string | undefined): string | null => {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  return new Date(timestamp).toISOString();
};

const sortOldestFirst = (items: ParsedFeedItem[]): ParsedFeedItem[] => {
  return [...items].sort((left, right) => {
    const leftTime = left.publishedAt ? Date.parse(left.publishedAt) : Number.MAX_SAFE_INTEGER;
    const rightTime = right.publishedAt ? Date.parse(right.publishedAt) : Number.MAX_SAFE_INTEGER;
    return leftTime - rightTime;
  });
};

export const parseRssFeed = async (xml: string, subscriptionUrl: string): Promise<ParsedFeed> => {
  const parser = new Parser();
  const feed = await parser.parseString(xml);

  const items = feed.items.map((item) => {
    const link = item.link ?? item.guid ?? subscriptionUrl;
    const title = item.title ?? item.contentSnippet?.slice(0, 100) ?? "Untitled";

    return {
      title,
      link,
      publishedAt: parseDate(item.isoDate ?? item.pubDate),
    };
  });

  return {
    title: asCleanString((feed as { title?: unknown }).title),
    siteUrl: resolveOptionalUrl(extractFeedSiteUrl(feed), subscriptionUrl),
    imageUrl: extractFeedImageUrl(feed),
    items: sortOldestFirst(items),
  };
};

export const parseRssItems = async (
  xml: string,
  subscriptionUrl: string,
): Promise<ParsedFeedItem[]> => {
  const parsed = await parseRssFeed(xml, subscriptionUrl);
  return parsed.items;
};
