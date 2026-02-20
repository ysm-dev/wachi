import { WachiError } from "../../utils/error.ts";
import type { CssSubscriptionConfig } from "../config/schema.ts";
import { extractCssItems } from "../css/extract.ts";
import { http } from "../http/client.ts";
import { waitForDomainRateLimit } from "../http/rate-limit.ts";
import type { SourceIdentity } from "../notify/source-identity.ts";
import {
  extractWebsiteBranding,
  fallbackWebsiteFaviconUrl,
  fallbackWebsiteTitle,
  googleS2FaviconUrl,
} from "./source-branding.ts";
import type { SubscriptionItem } from "./subscription-item.ts";

type FetchCssSubscriptionItemsResult = {
  items: SubscriptionItem[];
  sourceIdentity: SourceIdentity;
};

export const fetchCssSubscriptionItems = async (
  subscription: CssSubscriptionConfig,
): Promise<FetchCssSubscriptionItemsResult> => {
  await waitForDomainRateLimit(subscription.url);
  const response = await http.raw(subscription.url, {
    responseType: "text",
    ignoreResponseError: true,
  });

  if (response.status >= 400) {
    throw new WachiError(
      `Failed to fetch ${subscription.url}`,
      `HTTP ${response.status} ${response.statusText}. The page request failed.`,
      "Check if the URL is still valid or reachable.",
    );
  }

  const html = typeof response._data === "string" ? response._data : "";
  const branding = extractWebsiteBranding(subscription.url, html);
  const items = extractCssItems(html, subscription.url, {
    item_selector: subscription.item_selector,
    title_selector: subscription.title_selector,
    link_selector: subscription.link_selector,
  });

  const username = branding.title ?? fallbackWebsiteTitle(subscription.url) ?? undefined;
  const avatarUrl =
    branding.faviconUrl ??
    fallbackWebsiteFaviconUrl(subscription.url) ??
    googleS2FaviconUrl(subscription.url) ??
    undefined;

  return {
    items: items.map((item) => ({
      title: item.title,
      link: item.link,
      publishedAt: null,
    })),
    sourceIdentity: {
      username,
      avatarUrl,
    },
  };
};
