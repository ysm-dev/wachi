import { ofetch } from "ofetch";
import { VERSION } from "../../version.ts";

export const http = ofetch.create({
  timeout: 30_000,
  retry: 3,
  retryDelay: 1_000,
  retryStatusCodes: [408, 429, 500, 502, 503, 504],
  headers: {
    "User-Agent": `wachi/${VERSION}`,
  },
});
