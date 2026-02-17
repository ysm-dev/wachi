import { z } from "zod";
import { WachiError } from "../../utils/error.ts";
import { ensureUvx } from "./install-uv.ts";

const sendNotificationOptionsSchema = z.object({
  appriseUrl: z.string(),
  body: z.string(),
  timeoutMs: z.number().optional(),
});

type SendNotificationOptions = z.infer<typeof sendNotificationOptionsSchema>;

export const sendNotification = async ({
  appriseUrl,
  body,
  timeoutMs = 30_000,
}: SendNotificationOptions): Promise<void> => {
  await ensureUvx();

  const proc = Bun.spawn(["uvx", "apprise", "-b", body, appriseUrl], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(
        new WachiError(
          `Failed to send notification to ${appriseUrl}`,
          "apprise timed out after 30 seconds.",
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
      "Verify the apprise URL with `wachi test <apprise-url>`.",
    );
  }
};
