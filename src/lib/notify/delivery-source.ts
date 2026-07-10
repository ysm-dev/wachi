import { z } from "zod";
import { sourceIdentitySchema } from "./source-identity.ts";

export const deliverySourceSchema = z.object({
  channelName: z.string(),
  subscriptionUrl: z.string(),
  title: z.string(),
  archiveLink: z.string(),
  sourceIdentity: sourceIdentitySchema.optional(),
});

export type DeliverySource = z.infer<typeof deliverySourceSchema>;

export const serializeDeliverySource = (source: DeliverySource): string => {
  return JSON.stringify(deliverySourceSchema.parse(source));
};

export const parseDeliverySource = (source: string): DeliverySource => {
  return deliverySourceSchema.parse(JSON.parse(source));
};
