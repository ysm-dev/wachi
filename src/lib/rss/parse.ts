import Parser from "rss-parser";
import { z } from "zod";

const MAX_FEED_ITEMS = 20;

const parsedFeedItemSchema = z.object({
  title: z.string().min(1),
  link: z.string().min(1),
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

const isUrlLikeGuid = (value: string | undefined): value is string => {
  if (!value) {
    return false;
  }
  return /^(?:https?:\/\/|\/|\.\.?\/)/i.test(value.trim());
};

export const parseRssFeed = async (xml: string, subscriptionUrl: string): Promise<ParsedFeed> => {
  const parser = new Parser({
    xml2js: {
      // rss-parser converts Atom dates internally and throws on invalid values.
      // Ignore date values before conversion, including those inside CDATA.
      valueProcessors: [
        (value: string, name: string) =>
          /^(updated|published|pubDate|dc:date)$/.test(name) ? "" : value,
      ],
    },
    customFields: {
      feed: ["logo", "icon"],
    },
  });
  const feed = await parser.parseString(xml);

  const feedRecord = asRecord(feed);
  const rawItems = Array.isArray(feedRecord?.items) ? feedRecord.items : [];
  // Limit the source window before filtering or reversing so URL migrations
  // cannot enqueue an entire archive, even across repeated checks.
  const items = rawItems.slice(0, MAX_FEED_ITEMS).flatMap((rawItem): ParsedFeedItem[] => {
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
    items: items.reverse(),
  };
};

export const parseRssItems = async (
  xml: string,
  subscriptionUrl: string,
): Promise<ParsedFeedItem[]> => {
  const parsed = await parseRssFeed(xml, subscriptionUrl);
  return parsed.items;
};
