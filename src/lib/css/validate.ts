import { type CssSelectors, extractCssItems } from "./extract.ts";

export const validateCssSelectors = (
  html: string,
  subscriptionUrl: string,
  selectors: CssSelectors,
): boolean => {
  const items = extractCssItems(html, subscriptionUrl, selectors);
  return items.length > 0;
};
