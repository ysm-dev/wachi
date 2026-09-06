import { z } from "zod";
import { sourceIdentitySchema } from "./source-identity.ts";

export const deliverySourceSchema = z.object({
  kind: z.enum(["item", "subscription-failure"]).optional(),
  channelName: z.string(),
  subscriptionUrl: z.string(),
  title: z.string(),
  archiveLink: z.string().nullable(),
  sourceIdentity: sourceIdentitySchema.optional(),
  failureCount: z.number().int().positive().optional(),
});

export type DeliverySource = z.infer<typeof deliverySourceSchema>;

export const serializeDeliverySource = (source: DeliverySource): string => {
  return JSON.stringify(deliverySourceSchema.parse(source));
};

export const parseDeliverySource = (source: string): DeliverySource => {
  return deliverySourceSchema.parse(JSON.parse(source));
};

export const getDeliveryFailureCount = (source: DeliverySource): number | null => {
  if (source.kind === "subscription-failure") {
    return source.failureCount ?? 1;
  }

  // Failure alerts persisted before source kinds were added used this exact title.
  if (source.kind === undefined && source.archiveLink === null) {
    const match = /^Subscription failure \(([1-9]\d*)\)$/.exec(source.title);
    if (match?.[1]) {
      return Number(match[1]);
    }
  }

  return null;
};
