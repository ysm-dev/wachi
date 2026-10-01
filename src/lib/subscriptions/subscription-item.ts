import { z } from "zod";

export const subscriptionItemSchema = z.object({
  title: z.string(),
  link: z.string(),
});

export type SubscriptionItem = z.infer<typeof subscriptionItemSchema>;
