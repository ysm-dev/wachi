const parseHttpUrl = (rawUrl: string, baseUrl?: string): URL | null => {
  if (rawUrl.trim().length === 0) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = baseUrl === undefined ? new URL(rawUrl) : new URL(rawUrl, baseUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  return parsed;
};

/**
 * Canonicalizes a feed item link for permanent delivery identity.
 *
 * Fragments are preserved. Anchor-based feeds address many distinct items on one
 * page (per-comment permalinks such as `/topic?id=1#cid2`, hash-routed sites),
 * so the fragment is often the only thing telling two items apart. Dropping it
 * collapses them onto a single link key, which silently and permanently
 * suppresses every item after the first.
 */
export const canonicalizeItemUrl = (rawUrl: string, baseUrl?: string): string | null => {
  const parsed = parseHttpUrl(rawUrl, baseUrl);
  if (!parsed) {
    return null;
  }

  // A bare trailing "#" parses to an empty-but-present fragment that re-serializes
  // as "…/post#". Clearing it keeps that identical to "…/post".
  if (parsed.hash.length === 0) {
    parsed.hash = "";
  }

  return parsed.toString();
};

/**
 * Canonicalizes a feed (subscription) URL for config and subscription identity.
 *
 * Unlike item links, fragments are stripped here: a fragment is never sent to the
 * server, so `feed.xml` and `feed.xml#anything` always fetch the same document and
 * must count as the same subscription.
 */
export const canonicalizeFeedUrl = (rawUrl: string): string | null => {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) {
    return null;
  }

  parsed.hash = "";
  return parsed.toString();
};
