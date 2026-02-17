import { sha256 } from "../../utils/hash.ts";

export const buildDedupHash = (channelUrl: string, title: string, link: string): string => {
  return sha256(`${link}${title}${channelUrl}`);
};
