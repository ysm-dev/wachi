import { load } from "cheerio";
import { resolveUrl } from "../url/resolve.ts";

type WebsiteBranding = {
  title: string | null;
  faviconUrl: string | null;
};

const asCleanString = (value: string | undefined | null): string | null => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseIconSize = (sizes: string | undefined): number => {
  if (!sizes) {
    return 0;
  }

  if (/\bany\b/i.test(sizes)) {
    return 1_000_000;
  }

  let best = 0;
  for (const match of sizes.matchAll(/(\d+)\s*x\s*(\d+)/gi)) {
    const width = Number.parseInt(match[1] ?? "0", 10);
    const height = Number.parseInt(match[2] ?? "0", 10);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      continue;
    }
    best = Math.max(best, width * height);
  }
  return best;
};

const getIconPriority = (rel: string): number => {
  const normalized = rel.toLowerCase().trim().replace(/\s+/g, " ");
  if (normalized.includes("apple-touch-icon")) {
    return 3;
  }
  if (normalized.includes("shortcut icon")) {
    return 1;
  }
  if (normalized.includes("icon")) {
    return 2;
  }
  return 0;
};

export const extractWebsiteBranding = (pageUrl: string, html: string): WebsiteBranding => {
  const $ = load(html);
  const title = asCleanString($("title").first().text());

  let faviconUrl: string | null = null;
  let bestPriority = -1;
  let bestSize = -1;

  $("link[href]").each((_index, element) => {
    const rel = $(element).attr("rel") ?? "";
    const priority = getIconPriority(rel);
    if (priority === 0) {
      return;
    }

    const href = asCleanString($(element).attr("href"));
    if (!href) {
      return;
    }

    const size = parseIconSize($(element).attr("sizes"));
    if (priority < bestPriority || (priority === bestPriority && size <= bestSize)) {
      return;
    }

    const resolvedHref = resolveUrl(href, pageUrl);
    if (!resolvedHref) {
      return;
    }

    bestPriority = priority;
    bestSize = size;
    faviconUrl = resolvedHref;
  });

  return { title, faviconUrl };
};

export const fallbackWebsiteTitle = (pageUrl: string): string | null => {
  try {
    const hostname = new URL(pageUrl).hostname;
    const withoutWww = hostname.replace(/^www\./i, "");
    return asCleanString(withoutWww);
  } catch {
    return null;
  }
};

export const fallbackWebsiteFaviconUrl = (pageUrl: string): string | null => {
  try {
    const parsed = new URL(pageUrl);
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
};

export const googleS2FaviconUrl = (pageUrl: string): string | null => {
  try {
    const hostname = new URL(pageUrl).hostname;
    if (!hostname) {
      return null;
    }
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=128`;
  } catch {
    return null;
  }
};
