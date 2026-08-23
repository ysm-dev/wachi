import { load } from "cheerio";
import { isSafeDiscoveredHttpUrl } from "../url/network-policy.ts";
import { resolveHttpUrl } from "../url/resolve.ts";
import { detectRssUrl } from "./detect.ts";

const MAX_ALTERNATE_FEED_LINKS = 16;

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
    if (discovered.length >= MAX_ALTERNATE_FEED_LINKS) {
      return false;
    }

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
      const resolved = resolveHttpUrl(href, pageUrl);
      if (resolved && isSafeDiscoveredHttpUrl(resolved, pageUrl)) {
        discovered.push(resolved);
      }
    }
  });

  return discovered;
};

export const discoverRssFeedUrl = async (pageUrl: string, html: string): Promise<string | null> => {
  const candidates: string[] = [];
  candidates.push(...extractAlternateLinks(html, pageUrl));

  for (const path of COMMON_FEED_PATHS) {
    const resolved = resolveHttpUrl(path, pageUrl);
    if (resolved && isSafeDiscoveredHttpUrl(resolved, pageUrl)) {
      candidates.push(resolved);
    }
  }

  const deduped = [...new Set(candidates)];
  for (const candidate of deduped) {
    try {
      const detected = await detectRssUrl(candidate);
      if (detected.status < 400 && detected.isRss) {
        return detected.url;
      }
    } catch {}
  }

  return null;
};
