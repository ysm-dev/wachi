import { z } from "zod";
import { toChannelNameKey } from "./channel-name-key.ts";

export const cleanupConfigSchema = z.object({
  ttl_days: z.number().int().positive().default(90),
  max_records: z.number().int().positive().default(50_000),
});

export const subscriptionSchema = z.object({
  url: z.string().url(),
  rss_url: z.string().url(),
});

export const channelSchema = z.object({
  name: z.string().trim().min(1),
  apprise_url: z.string().min(1),
  subscriptions: z.array(subscriptionSchema).default([]),
});

const channelsSchema = z.array(channelSchema).superRefine((channels, context) => {
  const seen = new Set<string>();

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
  }
});

export const userConfigSchema = z.object({
  cleanup: cleanupConfigSchema.partial().optional(),
  channels: channelsSchema.optional(),
});

export const resolvedConfigSchema = z.object({
  cleanup: cleanupConfigSchema.default({ ttl_days: 90, max_records: 50_000 }),
  channels: channelsSchema.default([]),
});

export type UserConfig = z.infer<typeof userConfigSchema>;
export type ResolvedConfig = z.infer<typeof resolvedConfigSchema>;
export type ChannelConfig = z.infer<typeof channelSchema>;
export type SubscriptionConfig = z.infer<typeof subscriptionSchema>;

export const applyConfigDefaults = (config: UserConfig): ResolvedConfig => {
  return resolvedConfigSchema.parse(config);
};
