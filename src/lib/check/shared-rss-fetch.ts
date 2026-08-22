import type { WachiDb } from "../db/connect.ts";
import {
  type FetchRssItemsResult,
  fetchRssDocument,
  type RssValidators,
  readRssValidators,
  resolveRssSourceIdentity,
} from "../subscriptions/fetch-rss-subscription-items.ts";

type SharedFeedConsumer = {
  destinationId: number;
  cutoverComplete: boolean;
};

const validatorsEqual = (left: RssValidators, right: RssValidators): boolean => {
  return left.etag === right.etag && left.lastModified === right.lastModified;
};

export const resolveSharedRssValidators = (
  db: WachiDb,
  rssUrl: string,
  consumers: SharedFeedConsumer[],
): RssValidators | undefined => {
  if (consumers.length === 0 || consumers.some(({ cutoverComplete }) => !cutoverComplete)) {
    return undefined;
  }

  const destinationIds = new Set(consumers.map(({ destinationId }) => destinationId));
  let common: RssValidators | undefined;
  for (const destinationId of destinationIds) {
    const validators = readRssValidators(db, rssUrl, `destination:${destinationId}`);
    if (!validators.etag && !validators.lastModified) {
      return undefined;
    }
    if (common && !validatorsEqual(common, validators)) {
      return undefined;
    }
    common = validators;
  }
  return common;
};

export const createSharedRssFetcher = ({
  db,
  rssUrl,
  requestValidators,
  rateLimitAcquired,
}: {
  db: WachiDb;
  rssUrl: string;
  requestValidators?: RssValidators;
  rateLimitAcquired: boolean;
}) => {
  const documentPromise = fetchRssDocument({ rssUrl, requestValidators, rateLimitAcquired });
  const sourceIdentityPromises = new Map<string, ReturnType<typeof resolveRssSourceIdentity>>();

  return async (subscriptionUrl: string): Promise<FetchRssItemsResult> => {
    const document = await documentPromise;
    if (document.notModified) {
      return { notModified: true, items: [], validators: document.validators };
    }

    let sourceIdentityPromise = sourceIdentityPromises.get(subscriptionUrl);
    if (!sourceIdentityPromise) {
      sourceIdentityPromise = resolveRssSourceIdentity({
        subscriptionUrl,
        rssUrl,
        feedTitle: document.feedTitle,
        feedImageUrl: document.feedImageUrl,
        db,
      });
      sourceIdentityPromises.set(subscriptionUrl, sourceIdentityPromise);
    }

    return {
      notModified: false,
      items: document.items,
      sourceIdentity: await sourceIdentityPromise,
      validators: document.validators,
    };
  };
};
