import { createHash } from "node:crypto";
import { normalizeRawWebhookUrl } from "./source-identity.ts";

export const DESTINATION_KEY_VERSION = 1;

const PRESENTATION_USERNAME_SCHEMES = new Set(["discord", "slack", "mmost", "mmosts"]);

const normalizedDestinationUrl = (effectiveAppriseUrl: string): URL => {
  let parsed: URL;
  try {
    parsed = normalizeRawWebhookUrl(new URL(effectiveAppriseUrl));
  } catch {
    throw new TypeError("Destination must be a valid Apprise URL");
  }

  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (PRESENTATION_USERNAME_SCHEMES.has(scheme)) {
    parsed.username = "";
  }
  parsed.searchParams.delete("avatar_url");
  parsed.searchParams.sort();

  if (scheme === "discord") {
    parsed.password = "";
    parsed.pathname = "/";
  }

  return parsed;
};

export const buildDestinationKey = (effectiveAppriseUrl: string): Buffer => {
  const normalizedUrl = normalizedDestinationUrl(effectiveAppriseUrl);

  return createHash("sha256")
    .update(`wachi:destination-key:v${DESTINATION_KEY_VERSION}\0`)
    .update(normalizedUrl.toString())
    .digest();
};
