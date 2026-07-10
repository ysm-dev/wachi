import { z } from "zod";
import { WachiError } from "../../utils/error.ts";
import { maskAppriseUrl } from "../cli/io.ts";
import { ensureUvx } from "./install-uv.ts";
import { personalizeAppriseUrl, sourceIdentitySchema } from "./source-identity.ts";

const DEFAULT_NOTIFICATION_TIMEOUT_MS = 8_000;

/**
 * Whether a failed send definitively did NOT reach the provider ("undelivered",
 * safe to retry) or whether the outcome is ambiguous ("unknown", the provider
 * may already have accepted it, so retrying risks a duplicate).
 */
export type DeliveryFailureOutcome = "undelivered" | "unknown";

export class NotificationDeliveryError extends WachiError {
  readonly outcome: DeliveryFailureOutcome;

  constructor(outcome: DeliveryFailureOutcome, what: string, why: string, fix: string) {
    super(what, why, fix);
    this.name = "NotificationDeliveryError";
    this.outcome = outcome;
  }
}

let notificationRuntimeReady: Promise<void> | null = null;

const ensureNotificationRuntime = async (): Promise<void> => {
  if (!notificationRuntimeReady) {
    notificationRuntimeReady = ensureUvx().catch((error) => {
      notificationRuntimeReady = null;
      throw error;
    });
  }

  await notificationRuntimeReady;
};

export const resetSendNotificationStateForTest = (): void => {
  notificationRuntimeReady = null;
};

const sendNotificationOptionsSchema = z.object({
  appriseUrl: z.string(),
  body: z.string(),
  timeoutMs: z.number().optional(),
  sourceIdentity: sourceIdentitySchema.optional(),
  onDispatchStart: z.custom<() => void | Promise<void>>().optional(),
});

type SendNotificationOptions = z.infer<typeof sendNotificationOptionsSchema>;

export const sendNotification = async ({
  appriseUrl,
  body,
  timeoutMs = DEFAULT_NOTIFICATION_TIMEOUT_MS,
  sourceIdentity,
  onDispatchStart,
}: SendNotificationOptions): Promise<void> => {
  await ensureNotificationRuntime();

  const effectiveAppriseUrl = personalizeAppriseUrl(appriseUrl, sourceIdentity);
  await onDispatchStart?.();

  const proc = Bun.spawn(["uvx", "apprise", "-b", body, effectiveAppriseUrl], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(
        // The subprocess was killed mid-flight: apprise may already have posted
        // the webhook before we killed it, so the outcome is ambiguous.
        new NotificationDeliveryError(
          "unknown",
          `Failed to send notification to ${maskAppriseUrl(appriseUrl)}`,
          `apprise timed out after ${Math.ceil(timeoutMs / 1_000)} seconds.`,
          "Check network connectivity and apprise service health, then try again.",
        ),
      );
    }, timeoutMs);
    proc.exited.finally(() => clearTimeout(timer));
  });

  await Promise.race([proc.exited, timeout]);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new NotificationDeliveryError(
      // A non-zero exit means apprise ran to completion and reported failure,
      // so the message was definitively not delivered and is safe to retry.
      "undelivered",
      `Failed to send notification to ${maskAppriseUrl(appriseUrl)}`,
      stderr.trim() || "uvx apprise exited with an error.",
      "Verify the channel with `wachi test -n <name>`.",
    );
  }
};
