import TurndownService from "turndown";

const turndown = new TurndownService();

export const htmlToMarkdown = (html: string): string => {
  return turndown.turndown(html);
};
