import { z } from "zod";
import { toChannelNameKey } from "./channel-name-key.ts";

export const llmConfigSchema = z.object({
  base_url: z.string().url().default("https://api.openai.com/v1"),
  api_key: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

export const summaryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  prompt: z.string().min(1).default("Summarize this article concisely."),
  language: z.string().min(2).max(5).default("en"),
  min_reading_time: z.number().int().nonnegative().default(0),
});

export const cleanupConfigSchema = z.object({
  ttl_days: z.number().int().positive().default(90),
  max_records: z.number().int().positive().default(50_000),
});

export const rssSubscriptionSchema = z.object({
  url: z.string().url(),
  rss_url: z.string().url(),
});

export const cssSubscriptionSchema = z.object({
  url: z.string().url(),
  item_selector: z.string().min(1),
  title_selector: z.string().min(1),
  link_selector: z.string().min(1),
});

export const subscriptionSchema = z.union([rssSubscriptionSchema, cssSubscriptionSchema]);

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
  llm: llmConfigSchema.partial().optional(),
  summary: summaryConfigSchema.partial().optional(),
  cleanup: cleanupConfigSchema.partial().optional(),
  channels: channelsSchema.optional(),
});

const llmDefaultsSchema = llmConfigSchema.extend({
  api_key: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

export const resolvedConfigSchema = z.object({
  llm: llmDefaultsSchema.default({ base_url: "https://api.openai.com/v1" }),
  summary: summaryConfigSchema.default({
    enabled: false,
    prompt: "Summarize this article concisely.",
    language: "en",
    min_reading_time: 0,
  }),
  cleanup: cleanupConfigSchema.default({ ttl_days: 90, max_records: 50_000 }),
  channels: channelsSchema.default([]),
});

export type UserConfig = z.infer<typeof userConfigSchema>;
export type ResolvedConfig = z.infer<typeof resolvedConfigSchema>;
export type ChannelConfig = z.infer<typeof channelSchema>;
export type SubscriptionConfig = z.infer<typeof subscriptionSchema>;
export type RssSubscriptionConfig = z.infer<typeof rssSubscriptionSchema>;
export type CssSubscriptionConfig = z.infer<typeof cssSubscriptionSchema>;

export const applyConfigDefaults = (config: UserConfig): ResolvedConfig => {
  return resolvedConfigSchema.parse(config);
};

export const isRssSubscription = (
  subscription: SubscriptionConfig,
): subscription is RssSubscriptionConfig => {
  return "rss_url" in subscription;
};

export const isCssSubscription = (
  subscription: SubscriptionConfig,
): subscription is CssSubscriptionConfig => {
  return "item_selector" in subscription;
};
