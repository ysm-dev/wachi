import { parseRssFeed } from "../rss/parse.ts";
import { canonicalizeItemUrl } from "../url/canonicalize-item-url.ts";
import { normalizeUrl } from "../url/normalize.ts";
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
    // Resolve item links against the feed URL so baseline keys match the keys
    // computed on later checks (which also resolve against the RSS URL).
    baselineItems: parsedFeed.items.map((item) => ({
      title: item.title,
      link: canonicalizeItemUrl(item.link, rssUrl) ?? item.link,
    })),
    warning: undefined,
  };
};
