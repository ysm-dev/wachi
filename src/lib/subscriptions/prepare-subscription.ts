import { WachiError } from "../../utils/error.ts";
import { detectRssUrl } from "../rss/detect.ts";
import { discoverRssFeedUrl } from "../rss/discover.ts";
import { prepareRssFromDetectedFeed } from "./prepare-rss-from-detected-feed.ts";
import { prepareRssFromDiscoveredFeed } from "./prepare-rss-from-discovered-feed.ts";
import type { PreparedSubscription } from "./prepare-subscription-types.ts";

export const prepareSubscription = async (normalizedUrl: string): Promise<PreparedSubscription> => {
  const initialFetch = await detectRssUrl(normalizedUrl);
  if (initialFetch.status >= 400) {
    throw new WachiError(
      `Failed to reach ${normalizedUrl}`,
      `HTTP ${initialFetch.status} ${initialFetch.statusText}. The URL does not exist or is unavailable.`,
      "Check the URL and try again.",
    );
  }

  if (initialFetch.isRss) {
    return prepareRssFromDetectedFeed(normalizedUrl, initialFetch.body);
  }

  const discoveredRss = await discoverRssFeedUrl(normalizedUrl, initialFetch.body);
  if (discoveredRss) {
    return prepareRssFromDiscoveredFeed(normalizedUrl, discoveredRss);
  }

  throw new WachiError(
    `No RSS feed found for ${normalizedUrl}`,
    "The URL is not an RSS/Atom feed and no feed link was discovered in the page.",
    "Provide a direct RSS/Atom feed URL instead.",
  );
};
