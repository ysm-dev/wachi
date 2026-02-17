import { z } from "zod";
import type { SubscriptionConfig } from "../config/schema.ts";

export const baselineItemSchema = z.object({
  title: z.string(),
  link: z.string(),
});

export type BaselineItem = z.infer<typeof baselineItemSchema>;

const preparedSubscriptionSchema = z.object({
  subscription: z.custom<SubscriptionConfig>(),
  subscriptionType: z.union([z.literal("rss"), z.literal("css")]),
  baselineItems: z.array(baselineItemSchema),
  warning: z.string().optional(),
});

export type PreparedSubscription = z.infer<typeof preparedSubscriptionSchema>;
