import type { ResolvedConfig } from "../config/schema.ts";
import { identifyCssSelectors } from "../css/identify.ts";
import { createCssSubscription } from "./create-css-subscription.ts";
import { fetchCssSubscriptionItems } from "./fetch-css-subscription-items.ts";
import type { PreparedSubscription } from "./prepare-subscription-types.ts";

export const prepareCssSubscription = async (
  url: string,
  config: ResolvedConfig,
): Promise<PreparedSubscription> => {
  const identified = await identifyCssSelectors(url, config);
  const subscription = createCssSubscription(url, identified.selectors);
  const fetched = await fetchCssSubscriptionItems(subscription);
  const baselineItems = fetched.items.map((item) => ({
    title: item.title,
    link: item.link,
  }));

  return {
    subscription,
    subscriptionType: "css",
    baselineItems,
    warning: identified.warning,
  };
};
