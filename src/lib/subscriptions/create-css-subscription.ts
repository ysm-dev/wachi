import type { CssSubscriptionConfig } from "../config/schema.ts";
import type { CssSelectors } from "../css/extract.ts";

export const createCssSubscription = (
  url: string,
  selectors: CssSelectors,
): CssSubscriptionConfig => {
  return {
    url,
    item_selector: selectors.item_selector,
    title_selector: selectors.title_selector,
    link_selector: selectors.link_selector,
  };
};
