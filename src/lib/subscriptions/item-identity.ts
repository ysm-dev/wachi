import { createHash } from "node:crypto";
import { canonicalizeItemUrl } from "../url/canonicalize-item-url.ts";

export const LINK_KEY_VERSION = 1;

export const buildLinkKey = (rawUrl: string, baseUrl?: string): Buffer => {
  const canonicalUrl = canonicalizeItemUrl(rawUrl, baseUrl);
  if (!canonicalUrl) {
    throw new TypeError("Item link must resolve to a valid HTTP or HTTPS URL");
  }

  return createHash("sha256")
    .update(`wachi:link-key:v${LINK_KEY_VERSION}\0`)
    .update(canonicalUrl)
    .digest();
};
