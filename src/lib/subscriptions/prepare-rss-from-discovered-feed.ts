import { fetchRssSubscriptionItems } from "./fetch-rss-subscription-items.ts";
import type { PreparedSubscription } from "./prepare-subscription-types.ts";

export const prepareRssFromDiscoveredFeed = async (
  url: string,
  rssUrl: string,
): Promise<PreparedSubscription> => {
  const fetched = await fetchRssSubscriptionItems({
    subscriptionUrl: url,
    rssUrl,
    useConditionalRequest: false,
  });

  return {
    subscription: { url, rss_url: rssUrl },
    subscriptionType: "rss",
    baselineItems: fetched.items.map((item) => ({ title: item.title, link: item.link })),
    warning: undefined,
  };
};
