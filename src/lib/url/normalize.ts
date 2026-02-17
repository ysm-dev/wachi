import { z } from "zod";

const hasProtocol = (value: string): boolean => {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value);
};

const normalizedUrlSchema = z.object({
  url: z.string(),
  prependedHttps: z.boolean(),
});

export type NormalizedUrl = z.infer<typeof normalizedUrlSchema>;

export const normalizeUrl = (rawUrl: string): NormalizedUrl => {
  const trimmed = rawUrl.trim();
  const prependedHttps = !hasProtocol(trimmed);
  const withProtocol = prependedHttps ? `https://${trimmed}` : trimmed;

  const parsed = new URL(withProtocol);
  let normalized = parsed.toString();

  if (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  return {
    url: normalized,
    prependedHttps,
  };
};
