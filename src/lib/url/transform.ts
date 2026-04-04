import type { LinkTransform } from "../config/schema.ts";

const stripWww = (hostname: string): string => {
  return hostname.replace(/^www\./, "");
};

export const transformLink = (link: string, transforms: LinkTransform[]): string => {
  if (transforms.length === 0) {
    return link;
  }

  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return link;
  }

  const normalizedHost = stripWww(url.hostname);

  for (const { from, to } of transforms) {
    if (normalizedHost === stripWww(from)) {
      url.hostname = to;
      return url.toString();
    }
  }

  return link;
};
