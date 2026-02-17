import { WachiError } from "../../utils/error.ts";
import type { CssSubscriptionConfig } from "../config/schema.ts";
import { extractCssItems } from "../css/extract.ts";
import { http } from "../http/client.ts";
import { waitForDomainRateLimit } from "../http/rate-limit.ts";
import type { SubscriptionItem } from "./subscription-item.ts";

export const fetchCssSubscriptionItems = async (
  subscription: CssSubscriptionConfig,
): Promise<SubscriptionItem[]> => {
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
  const items = extractCssItems(html, subscription.url, {
    item_selector: subscription.item_selector,
    title_selector: subscription.title_selector,
    link_selector: subscription.link_selector,
  });

  return items.map((item) => ({
    title: item.title,
    link: item.link,
    publishedAt: null,
  }));
};
