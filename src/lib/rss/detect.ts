import { z } from "zod";
import { fetchBoundedText } from "../http/client.ts";

const RSS_DETECT_TIMEOUT_MS = 10_000;
const RSS_DETECT_MAX_BYTES = 5 * 1024 * 1024;

const detectRssResultSchema = z.object({
  isRss: z.boolean(),
  status: z.number(),
  statusText: z.string(),
  contentType: z.string(),
  body: z.string(),
  etag: z.string().nullable(),
  lastModified: z.string().nullable(),
  url: z.string(),
});

type DetectRssResult = z.infer<typeof detectRssResultSchema>;

const stripXmlPreamble = (value: string): string => {
  let remaining = value.trimStart();
  while (true) {
    if (remaining.startsWith("<?")) {
      const end = remaining.indexOf("?>", 2);
      if (end < 0) {
        return remaining;
      }
      remaining = remaining.slice(end + 2).trimStart();
      continue;
    }

    if (remaining.startsWith("<!--")) {
      const end = remaining.indexOf("-->", 4);
      if (end < 0) {
        return remaining;
      }
      remaining = remaining.slice(end + 3).trimStart();
      continue;
    }

    if (/^<!doctype\b/i.test(remaining)) {
      let subsetDepth = 0;
      let quote: '"' | "'" | null = null;
      let end = -1;
      for (let index = 9; index < remaining.length; index += 1) {
        const character = remaining[index];
        if (quote) {
          if (character === quote) {
            quote = null;
          }
        } else if (character === '"' || character === "'") {
          quote = character;
        } else if (character === "[") {
          subsetDepth += 1;
        } else if (character === "]") {
          subsetDepth = Math.max(0, subsetDepth - 1);
        } else if (character === ">" && subsetDepth === 0) {
          end = index;
          break;
        }
      }
      if (end < 0) {
        return remaining;
      }
      remaining = remaining.slice(end + 1).trimStart();
      continue;
    }

    return remaining;
  }
};

const bodyLooksLikeRss = (body: string): boolean => {
  const head = body
    .replace(/^\uFEFF/, "")
    .trimStart()
    .slice(0, 8_192);
  if (head.length === 0) {
    return false;
  }

  const withoutPreamble = stripXmlPreamble(head);
  return /^<(?:rss|rss:rss|feed|atom:feed|rdf:rdf)(?:\s|>)/i.test(withoutPreamble);
};

export const detectRssUrl = async (url: string): Promise<DetectRssResult> => {
  const response = await fetchBoundedText(url, {
    timeoutMs: RSS_DETECT_TIMEOUT_MS,
    maxBytes: RSS_DETECT_MAX_BYTES,
    headers: {
      Accept:
        "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8",
    },
  });

  const contentType = response.headers.get("content-type") ?? "";

  return {
    isRss: bodyLooksLikeRss(response.body),
    status: response.status,
    statusText: response.statusText,
    contentType,
    body: response.body,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
    url: response.url,
  };
};
