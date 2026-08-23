import Parser from "rss-parser";
import { z } from "zod";

const parsedFeedItemSchema = z.object({
  title: z.string().min(1),
  link: z.string().min(1),
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

  const atomLogoUrl = asCleanString(feedRecord.logo);
  if (atomLogoUrl) {
    return atomLogoUrl;
  }

  const atomIconUrl = asCleanString(feedRecord.icon);
  if (atomIconUrl) {
    return atomIconUrl;
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
    const resolved = new URL(value, baseUrl);
    return resolved.protocol === "http:" || resolved.protocol === "https:"
      ? resolved.toString()
      : null;
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

const toDeliveryOrder = (items: ParsedFeedItem[]): ParsedFeedItem[] => {
  const timestamped: Array<{ item: ParsedFeedItem; index: number; timestamp: number }> = [];
  const undated: Array<{ item: ParsedFeedItem; index: number }> = [];

  items.forEach((item, index) => {
    if (item.publishedAt) {
      timestamped.push({ item, index, timestamp: Date.parse(item.publishedAt) });
    } else {
      undated.push({ item, index });
    }
  });

  timestamped.sort((left, right) => left.timestamp - right.timestamp || right.index - left.index);
  undated.reverse();
  return [...timestamped.map(({ item }) => item), ...undated.map(({ item }) => item)];
};

const sanitizeInvalidDates = (xml: string): string => {
  return xml.replace(
    /<(updated|published|pubDate|dc:date)>([^<]*)<\/\1>/gi,
    (match, tag: string, rawValue: string) => {
      const value = rawValue.trim();
      return !value || value.toLowerCase() === "null" || Number.isNaN(Date.parse(value))
        ? `<${tag}></${tag}>`
        : match;
    },
  );
};

const isUrlLikeGuid = (value: string | undefined): value is string => {
  if (!value) {
    return false;
  }
  return /^(?:https?:\/\/|\/|\.\.?\/)/i.test(value.trim());
};

export const parseRssFeed = async (xml: string, subscriptionUrl: string): Promise<ParsedFeed> => {
  const parser = new Parser({
    customFields: {
      feed: ["logo", "icon"],
    },
  });
  const feed = await parser.parseString(sanitizeInvalidDates(xml));

  const feedRecord = asRecord(feed);
  const rawItems = Array.isArray(feedRecord?.items) ? feedRecord.items : [];
  const items = rawItems.flatMap((rawItem): ParsedFeedItem[] => {
    try {
      const item = asRecord(rawItem);
      if (!item) {
        return [];
      }

      const guid = asCleanString(item.guid);
      const link = asCleanString(item.link) ?? (isUrlLikeGuid(guid ?? undefined) ? guid : null);
      const snippet = asCleanString(item.contentSnippet);
      const candidate = parsedFeedItemSchema.safeParse({
        title: asCleanString(item.title) ?? snippet?.slice(0, 100) ?? "Untitled",
        link,
        publishedAt: parseDate(
          asCleanString(item.isoDate) ?? asCleanString(item.pubDate) ?? undefined,
        ),
      });

      if (!candidate.success || !resolveOptionalUrl(candidate.data.link, subscriptionUrl)) {
        return [];
      }
      return [candidate.data];
    } catch {
      return [];
    }
  });

  return {
    title: asCleanString((feed as { title?: unknown }).title),
    siteUrl: resolveOptionalUrl(extractFeedSiteUrl(feed), subscriptionUrl),
    imageUrl: extractFeedImageUrl(feed),
    items: toDeliveryOrder(items),
  };
};

export const parseRssItems = async (
  xml: string,
  subscriptionUrl: string,
): Promise<ParsedFeedItem[]> => {
  const parsed = await parseRssFeed(xml, subscriptionUrl);
  return parsed.items;
};
