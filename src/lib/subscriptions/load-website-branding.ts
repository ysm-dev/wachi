import { z } from "zod";
import type { WachiDb } from "../db/connect.ts";
import { getMetaValue } from "../db/get-meta-value.ts";
import { setMetaValue } from "../db/set-meta-value.ts";
import { fetchBoundedText } from "../http/client.ts";
import { waitForDomainRateLimit } from "../http/rate-limit.ts";
import { extractWebsiteBranding } from "./source-branding.ts";

const BRANDING_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const BRANDING_FETCH_TIMEOUT_MS = 2_000;
const BRANDING_FETCH_MAX_BYTES = 1024 * 1024;

const cachedWebsiteBrandingSchema = z.object({
  fetchedAt: z.string(),
  title: z.string().nullable(),
  faviconUrl: z.string().nullable(),
});

type WebsiteBranding = {
  title: string | null;
  faviconUrl: string | null;
};

const brandingMetaKey = (subscriptionUrl: string): string => `branding:${subscriptionUrl}`;

const getCachedWebsiteBranding = (db: WachiDb, subscriptionUrl: string): WebsiteBranding | null => {
  const raw = getMetaValue(db, brandingMetaKey(subscriptionUrl));
  if (!raw) {
    return null;
  }

  try {
    const parsed = cachedWebsiteBrandingSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return null;
    }

    const fetchedAt = Date.parse(parsed.data.fetchedAt);
    if (Number.isNaN(fetchedAt) || Date.now() - fetchedAt > BRANDING_CACHE_TTL_MS) {
      return null;
    }

    return {
      title: parsed.data.title,
      faviconUrl: parsed.data.faviconUrl,
    };
  } catch {
    return null;
  }
};

const setCachedWebsiteBranding = (
  db: WachiDb,
  subscriptionUrl: string,
  branding: WebsiteBranding,
): void => {
  setMetaValue(
    db,
    brandingMetaKey(subscriptionUrl),
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      title: branding.title,
      faviconUrl: branding.faviconUrl,
    }),
  );
};

const fetchWebsiteBranding = async (subscriptionUrl: string): Promise<WebsiteBranding> => {
  try {
    await waitForDomainRateLimit(subscriptionUrl);
    const response = await fetchBoundedText(subscriptionUrl, {
      timeoutMs: BRANDING_FETCH_TIMEOUT_MS,
      maxBytes: BRANDING_FETCH_MAX_BYTES,
      retry: 0,
    });
    if (response.status >= 400) {
      return { title: null, faviconUrl: null };
    }
    return extractWebsiteBranding(response.url, response.body);
  } catch {
    return { title: null, faviconUrl: null };
  }
};

export const loadWebsiteBranding = async (
  subscriptionUrl: string,
  db?: WachiDb,
): Promise<WebsiteBranding> => {
  if (db) {
    const cached = getCachedWebsiteBranding(db, subscriptionUrl);
    if (cached) {
      return cached;
    }
  }

  const branding = await fetchWebsiteBranding(subscriptionUrl);
  if (db) {
    setCachedWebsiteBranding(db, subscriptionUrl, branding);
  }

  return branding;
};
