import { normalizeRawWebhookUrl } from "./source-identity.ts";

/**
 * Upstream body length limits (characters), keyed by Apprise scheme.
 *
 * Apprise's own `overflow=` handling defaults to "upstream" for some
 * plugins (notably Discord), meaning an oversized body is sent as-is and
 * simply rejected by the provider rather than being split/truncated for
 * us. A scraped item's `title` has no upstream length cap (unlike an RSS
 * `desc`, which feed generators may truncate), so a single unusually long
 * item can exceed a provider's limit, fail every delivery attempt, and be
 * permanently parked as `uncertain` (see check/drain-outbox.ts) -- silently
 * dropping content that otherwise exists at the source.
 *
 * Values come from Apprise's per-plugin `body_maxlen`:
 *   - discord: apprise/plugins/discord.py (body_maxlen = 2000)
 *   - slack:   apprise/plugins/slack.py (body_maxlen = 35000)
 *   - tgram:   https://github.com/caronc/apprise/wiki/notify_telegram
 *              ("Message Limit: 4096 Characters per message")
 *
 * Schemes not listed here are left untouched (unlimited), matching prior
 * behavior; add an entry once a scheme's limit has been verified.
 */
const BODY_MAX_LENGTH_BY_SCHEME: Record<string, number> = {
  discord: 2000,
  slack: 35000,
  tgram: 4096,
};

const TRUNCATION_SUFFIX = "…";
const SEPARATOR = "\n\n";

const resolveScheme = (appriseUrl: string): string | null => {
  try {
    const parsed = normalizeRawWebhookUrl(new URL(appriseUrl));
    return parsed.protocol.replace(/:$/, "").toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Truncate `title` (never `link`) so `link + SEPARATOR + title` fits within
 * `maxLength`. Returns `title` unchanged if it already fits, or if `link`
 * alone leaves no room to fit anything meaningful (an extreme edge case
 * left for upstream to reject, same as before this limit existed).
 */
const fitTitleToLimit = (link: string, title: string, maxLength: number): string => {
  const budget = maxLength - link.length - SEPARATOR.length;
  if (budget <= 0 || title.length <= budget) {
    return title;
  }

  const sliceLength = Math.max(0, budget - TRUNCATION_SUFFIX.length);
  return `${title.slice(0, sliceLength).trimEnd()}${TRUNCATION_SUFFIX}`;
};

/**
 * Format a notification body, truncating `title` when necessary to stay
 * under the destination scheme's known upstream message-length limit.
 *
 * `appriseUrl` is optional so callers that don't know (or don't care about)
 * the destination -- e.g. existing tests -- keep the prior unbounded
 * behavior.
 */
export const formatNotificationBody = (
  link: string,
  title: string,
  appriseUrl?: string,
): string => {
  const scheme = appriseUrl ? resolveScheme(appriseUrl) : null;
  const maxLength = scheme ? BODY_MAX_LENGTH_BY_SCHEME[scheme] : undefined;
  const effectiveTitle = maxLength ? fitTitleToLimit(link, title, maxLength) : title;

  return `${link}${SEPARATOR}${effectiveTitle}`;
};
