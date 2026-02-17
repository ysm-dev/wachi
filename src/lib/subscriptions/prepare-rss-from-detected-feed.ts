import { parseRssItems } from "../rss/parse.ts";
import { resolveUrl } from "../url/resolve.ts";
import type { PreparedSubscription } from "./prepare-subscription-types.ts";

export const prepareRssFromDetectedFeed = async (
  url: string,
  xml: string,
): Promise<PreparedSubscription> => {
  const parsedItems = await parseRssItems(xml, url);

  return {
    subscription: { url, rss_url: url },
    subscriptionType: "rss",
    baselineItems: parsedItems.map((item) => ({
      title: item.title,
      link: resolveUrl(item.link, url),
    })),
    warning: undefined,
  };
};
