export const canonicalizeItemUrl = (rawUrl: string, baseUrl?: string): string | null => {
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

  parsed.hash = "";
  return parsed.toString();
};
