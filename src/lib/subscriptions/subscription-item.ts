import { z } from "zod";

export const subscriptionItemSchema = z.object({
  title: z.string(),
  link: z.string(),
  publishedAt: z.string().nullable(),
});

export type SubscriptionItem = z.infer<typeof subscriptionItemSchema>;
