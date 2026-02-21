import { parseRssFeed } from "../rss/parse.ts";
import { normalizeUrl } from "../url/normalize.ts";
import { resolveUrl } from "../url/resolve.ts";
import type { PreparedSubscription } from "./prepare-subscription-types.ts";

export const prepareRssFromDetectedFeed = async (
  rssUrl: string,
  xml: string,
): Promise<PreparedSubscription> => {
  const parsedFeed = await parseRssFeed(xml, rssUrl);
  const subscriptionUrl = parsedFeed.siteUrl ? normalizeUrl(parsedFeed.siteUrl).url : rssUrl;

  return {
    subscription: { url: subscriptionUrl, rss_url: rssUrl },
    subscriptionType: "rss",
    baselineItems: parsedFeed.items.map((item) => ({
      title: item.title,
      link: resolveUrl(item.link, subscriptionUrl),
    })),
    warning: undefined,
  };
};
