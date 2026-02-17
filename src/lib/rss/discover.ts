import { load } from "cheerio";
import { resolveUrl } from "../url/resolve.ts";
import { detectRssUrl } from "./detect.ts";

const COMMON_FEED_PATHS = [
  "/rss",
  "/rss.xml",
  "/feed",
  "/feed.xml",
  "/atom",
  "/atom.xml",
  "/feed/rss",
  "/feed/atom",
];

const extractAlternateLinks = (html: string, pageUrl: string): string[] => {
  const $ = load(html);
  const discovered: string[] = [];

  $("link[rel='alternate']").each((_index, element) => {
    const type = ($(element).attr("type") ?? "").toLowerCase();
    const href = $(element).attr("href");

    if (!href) {
      return;
    }

    if (
      type.includes("application/rss+xml") ||
      type.includes("application/atom+xml") ||
      type.includes("xml")
    ) {
      discovered.push(resolveUrl(href, pageUrl));
    }
  });

  return discovered;
};

export const discoverRssFeedUrl = async (pageUrl: string, html: string): Promise<string | null> => {
  const candidates: string[] = [];
  candidates.push(...extractAlternateLinks(html, pageUrl));

  for (const path of COMMON_FEED_PATHS) {
    candidates.push(resolveUrl(path, pageUrl));
  }

  const deduped = [...new Set(candidates)];
  for (const candidate of deduped) {
    try {
      const detected = await detectRssUrl(candidate);
      if (detected.status < 400 && detected.isRss) {
        return candidate;
      }
    } catch {}
  }

  return null;
};
