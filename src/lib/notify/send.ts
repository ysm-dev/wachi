import { z } from "zod";
import { WachiError } from "../../utils/error.ts";
import { ensureUvx } from "./install-uv.ts";
import { personalizeAppriseUrl, sourceIdentitySchema } from "./source-identity.ts";

const DEFAULT_NOTIFICATION_TIMEOUT_MS = 8_000;

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
});

type SendNotificationOptions = z.infer<typeof sendNotificationOptionsSchema>;

export const sendNotification = async ({
  appriseUrl,
  body,
  timeoutMs = DEFAULT_NOTIFICATION_TIMEOUT_MS,
  sourceIdentity,
}: SendNotificationOptions): Promise<void> => {
  await ensureNotificationRuntime();

  const effectiveAppriseUrl = personalizeAppriseUrl(appriseUrl, sourceIdentity);

  const proc = Bun.spawn(["uvx", "apprise", "-b", body, effectiveAppriseUrl], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(
        new WachiError(
          `Failed to send notification to ${appriseUrl}`,
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
    throw new WachiError(
      `Failed to send notification to ${appriseUrl}`,
      stderr.trim() || "uvx apprise exited with an error.",
      "Verify the channel with `wachi test -n <name>`.",
    );
  }
};
