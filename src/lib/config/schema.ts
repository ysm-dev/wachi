import { z } from "zod";
import { buildDestinationKey } from "../notify/destination-identity.ts";
import { canonicalizeFeedUrl } from "../url/canonicalize-item-url.ts";
import { toChannelNameKey } from "./channel-name-key.ts";

export const cleanupConfigSchema = z
  .object({
    // Accepted for compatibility with existing configs. Delivery keys are permanent.
    ttl_days: z.number().int().positive().default(90),
    max_records: z.number().int().positive().default(50_000),
  })
  .strict();

export const subscriptionSchema = z
  .object({
    url: z.string().url(),
    rss_url: z.string().url(),
  })
  .strict();

export const channelSchema = z
  .object({
    name: z.string().trim().min(1),
    apprise_url: z
      .string()
      .min(1)
      .refine(
        (value) => {
          try {
            buildDestinationKey(value);
            return true;
          } catch {
            return false;
          }
        },
        { message: "Must be a valid Apprise URL." },
      ),
    subscriptions: z.array(subscriptionSchema).default([]),
  })
  .strict();

const channelsSchema = z.array(channelSchema).superRefine((channels, context) => {
  const seen = new Set<string>();
  const subscriptionsByDestination = new Map<string, Set<string>>();

  for (const [index, channel] of channels.entries()) {
    const key = toChannelNameKey(channel.name);
    if (seen.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Channel names must be unique (case-insensitive).",
        path: [index, "name"],
      });
      continue;
    }

    seen.add(key);

    let destinationKey: string;
    try {
      destinationKey = buildDestinationKey(channel.apprise_url).toString("hex");
    } catch {
      continue;
    }
    const destinationSubscriptions =
      subscriptionsByDestination.get(destinationKey) ?? new Set<string>();
    subscriptionsByDestination.set(destinationKey, destinationSubscriptions);

    for (const [subscriptionIndex, subscription] of channel.subscriptions.entries()) {
      const rssUrl = canonicalizeFeedUrl(subscription.rss_url) ?? subscription.rss_url;
      if (destinationSubscriptions.has(rssUrl)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "RSS subscriptions must be unique per notification destination.",
          path: [index, "subscriptions", subscriptionIndex, "rss_url"],
        });
        continue;
      }
      destinationSubscriptions.add(rssUrl);
    }
  }
});

export const linkTransformSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
  })
  .strict();

export const userConfigSchema = z
  .object({
    cleanup: cleanupConfigSchema.partial().optional(),
    channels: channelsSchema.optional(),
    link_transforms: z.array(linkTransformSchema).optional(),
  })
  .strict();

export const resolvedConfigSchema = z.object({
  cleanup: cleanupConfigSchema.default({ ttl_days: 90, max_records: 50_000 }),
  channels: channelsSchema.default([]),
  link_transforms: z.array(linkTransformSchema).default([]),
});

export type UserConfig = z.infer<typeof userConfigSchema>;
export type ResolvedConfig = z.infer<typeof resolvedConfigSchema>;
export type ChannelConfig = z.infer<typeof channelSchema>;
export type SubscriptionConfig = z.infer<typeof subscriptionSchema>;
export type LinkTransform = z.infer<typeof linkTransformSchema>;

export const applyConfigDefaults = (config: UserConfig): ResolvedConfig => {
  return resolvedConfigSchema.parse(config);
};
