import type { WachiDb } from "../db/connect.ts";
import type { SourceIdentity } from "../notify/source-identity.ts";
import { fetchRssSubscriptionItems } from "./fetch-rss-subscription-items.ts";
import { loadWebsiteBranding } from "./load-website-branding.ts";
import {
  fallbackWebsiteFaviconUrl,
  fallbackWebsiteTitle,
  googleS2FaviconUrl,
} from "./source-branding.ts";

const hasSourceIdentity = (sourceIdentity?: SourceIdentity): boolean => {
  return Boolean(sourceIdentity?.username || sourceIdentity?.avatarUrl);
};

const resolveWebsiteSourceIdentity = async (
  subscriptionUrl: string,
  db?: WachiDb,
): Promise<SourceIdentity | undefined> => {
  const branding = await loadWebsiteBranding(subscriptionUrl, db);
  const username = branding.title ?? fallbackWebsiteTitle(subscriptionUrl) ?? undefined;
  const avatarUrl = branding.faviconUrl ?? undefined;

  const sourceIdentity = { username, avatarUrl };
  return hasSourceIdentity(sourceIdentity) ? sourceIdentity : undefined;
};

export const withLinkFallbackAvatar = (
  base: SourceIdentity | undefined,
  fallbackLink: string,
): SourceIdentity | undefined => {
  const username = base?.username;
  const avatarUrl =
    base?.avatarUrl ??
    fallbackWebsiteFaviconUrl(fallbackLink) ??
    googleS2FaviconUrl(fallbackLink) ??
    undefined;

  const sourceIdentity = { username, avatarUrl };
  return hasSourceIdentity(sourceIdentity) ? sourceIdentity : undefined;
};

export const resolveSourceIdentity = async ({
  subscriptionUrl,
  rssUrl,
  db,
  allowFeedFetch = true,
}: {
  subscriptionUrl: string;
  rssUrl?: string;
  db?: WachiDb;
  allowFeedFetch?: boolean;
}): Promise<SourceIdentity | undefined> => {
  if (allowFeedFetch && rssUrl) {
    try {
      const fetched = await fetchRssSubscriptionItems({
        subscriptionUrl,
        rssUrl,
        db,
        useConditionalRequest: false,
      });
      if (hasSourceIdentity(fetched.sourceIdentity)) {
        return fetched.sourceIdentity;
      }
    } catch {}
  }

  try {
    return await resolveWebsiteSourceIdentity(subscriptionUrl, db);
  } catch {
    return undefined;
  }
};
