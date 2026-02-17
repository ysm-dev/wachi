import Parser from "rss-parser";
import { z } from "zod";

const parsedFeedItemSchema = z.object({
  title: z.string(),
  link: z.string(),
  publishedAt: z.string().nullable(),
});

export type ParsedFeedItem = z.infer<typeof parsedFeedItemSchema>;

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

export const parseRssItems = async (
  xml: string,
  subscriptionUrl: string,
): Promise<ParsedFeedItem[]> => {
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

  return sortOldestFirst(items);
};
