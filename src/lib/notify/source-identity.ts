import { z } from "zod";

export const sourceIdentitySchema = z.object({
  username: z.string().optional(),
  avatarUrl: z.string().url().optional(),
});

export type SourceIdentity = z.infer<typeof sourceIdentitySchema>;

const USERNAME_SUPPORTED_SCHEMES = new Set(["discord", "slack", "mmost", "mmosts"]);
const AVATAR_URL_SUPPORTED_SCHEMES = new Set(["discord", "ntfy", "ntfys"]);

const isHttpScheme = (scheme: string): boolean => {
  return scheme === "http" || scheme === "https";
};

const normalizeDiscordWebhookUrl = (parsed: URL): URL | null => {
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (!isHttpScheme(scheme)) {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname !== "discord.com" &&
    hostname !== "www.discord.com" &&
    hostname !== "discordapp.com" &&
    hostname !== "www.discordapp.com"
  ) {
    return null;
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "webhooks") {
    return null;
  }

  const webhookId = parts[2];
  const webhookToken = parts[3];
  if (!webhookId || !webhookToken) {
    return null;
  }

  const normalized = new URL(`discord://${webhookId}/${webhookToken}/`);
  for (const [key, value] of parsed.searchParams.entries()) {
    normalized.searchParams.append(key, value);
  }
  return normalized;
};

const normalizeSlackWebhookUrl = (parsed: URL): URL | null => {
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (!isHttpScheme(scheme)) {
    return null;
  }

  if (parsed.hostname.toLowerCase() !== "hooks.slack.com") {
    return null;
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0] !== "services") {
    return null;
  }

  const tokenA = parts[1];
  const tokenB = parts[2];
  const tokenC = parts[3];
  if (!tokenA || !tokenB || !tokenC) {
    return null;
  }

  const normalized = new URL(`slack://${tokenA}/${tokenB}/${tokenC}`);
  for (const [key, value] of parsed.searchParams.entries()) {
    normalized.searchParams.append(key, value);
  }
  return normalized;
};

const normalizeRawWebhookUrl = (parsed: URL): URL => {
  const discordUrl = normalizeDiscordWebhookUrl(parsed);
  if (discordUrl) {
    return discordUrl;
  }

  const slackUrl = normalizeSlackWebhookUrl(parsed);
  if (slackUrl) {
    return slackUrl;
  }

  return parsed;
};

const clean = (value: string | undefined): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed : null;
};

export const personalizeAppriseUrl = (
  appriseUrl: string,
  sourceIdentity?: SourceIdentity,
): string => {
  const username = clean(sourceIdentity?.username);
  const avatarUrl = clean(sourceIdentity?.avatarUrl);
  if (!username && !avatarUrl) {
    return appriseUrl;
  }

  let parsed: URL;
  try {
    parsed = normalizeRawWebhookUrl(new URL(appriseUrl));
  } catch {
    return appriseUrl;
  }

  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (username && USERNAME_SUPPORTED_SCHEMES.has(scheme)) {
    parsed.username = username;
  }
  if (avatarUrl && AVATAR_URL_SUPPORTED_SCHEMES.has(scheme)) {
    parsed.searchParams.set("avatar_url", avatarUrl);
  }

  return parsed.toString();
};

export const normalizeAppriseUrlForIdentity = (appriseUrl: string): string => {
  let parsed: URL;
  try {
    parsed = normalizeRawWebhookUrl(new URL(appriseUrl));
  } catch {
    return appriseUrl;
  }

  parsed.username = "";
  parsed.searchParams.delete("avatar_url");
  return parsed.toString();
};
