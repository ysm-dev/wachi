import { z } from "zod";
import { http } from "../http/client.ts";

const detectRssResultSchema = z.object({
  isRss: z.boolean(),
  status: z.number(),
  statusText: z.string(),
  contentType: z.string(),
  body: z.string(),
  etag: z.string().nullable(),
  lastModified: z.string().nullable(),
});

type DetectRssResult = z.infer<typeof detectRssResultSchema>;

const contentTypeLooksLikeRss = (contentType: string): boolean => {
  const lower = contentType.toLowerCase();
  return lower.includes("xml") || lower.includes("rss") || lower.includes("atom");
};

const bodyLooksLikeRss = (body: string): boolean => {
  const head = body
    .replace(/^\uFEFF/, "")
    .trimStart()
    .slice(0, 2_048);
  if (head.length === 0) {
    return false;
  }

  const lower = head.toLowerCase();
  if (lower.startsWith("<!doctype html") || lower.includes("<html")) {
    return false;
  }

  return /<rss[\s>]|<feed[\s>]|<rdf:rdf[\s>]/i.test(head);
};

export const detectRssUrl = async (url: string): Promise<DetectRssResult> => {
  const response = await http.raw(url, {
    method: "GET",
    responseType: "text",
    headers: {
      Accept:
        "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8",
    },
  });

  const contentType = response.headers.get("content-type") ?? "";
  const body = typeof response._data === "string" ? response._data : "";

  return {
    isRss: contentTypeLooksLikeRss(contentType) || bodyLooksLikeRss(body),
    status: response.status,
    statusText: response.statusText,
    contentType,
    body,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
};
