import { load } from "cheerio";
import { z } from "zod";
import { resolveUrl } from "../url/resolve.ts";

export const cssSelectorsSchema = z.object({
  item_selector: z.string(),
  title_selector: z.string(),
  link_selector: z.string(),
});

export type CssSelectors = z.infer<typeof cssSelectorsSchema>;

const cssExtractedItemSchema = z.object({
  title: z.string(),
  link: z.string(),
});

export type CssExtractedItem = z.infer<typeof cssExtractedItemSchema>;

export const extractCssItems = (
  html: string,
  subscriptionUrl: string,
  selectors: CssSelectors,
): CssExtractedItem[] => {
  const $ = load(html);
  const items: CssExtractedItem[] = [];

  $(selectors.item_selector).each((_index, element) => {
    const root = $(element);
    const titleNode = root.find(selectors.title_selector).first();
    const linkNode = root.find(selectors.link_selector).first();

    const title = titleNode.text().trim() || linkNode.text().trim() || "Untitled";
    const href = linkNode.attr("href") ?? titleNode.attr("href") ?? subscriptionUrl;
    const link = resolveUrl(href, subscriptionUrl);

    items.push({ title, link });
  });

  return items;
};
