import { getEnv } from "../../utils/env.ts";
import { printStderr } from "../cli/io.ts";
import { submitWaybackGet, submitWaybackPost } from "./client.ts";
import { trackArchive } from "./pool.ts";
import { shouldArchive } from "./url-policy.ts";

type SubmitArchiveOptions = {
  isVerbose?: boolean;
};

let anonymousHintShown = false;

export const submitArchive = (
  link: string,
  { isVerbose = false }: SubmitArchiveOptions = {},
): void => {
  const env = getEnv();
  if (env.noArchive || !shouldArchive(link)) {
    return;
  }

  const hasArchiveCredentials = Boolean(env.archiveAccessKey && env.archiveSecretKey);
  if (!hasArchiveCredentials && isVerbose && !anonymousHintShown) {
    anonymousHintShown = true;
    printStderr(
      "[verbose] archive: using anonymous Wayback API; set WACHI_ARCHIVE_ACCESS_KEY and WACHI_ARCHIVE_SECRET_KEY for authenticated submissions",
    );
  }

  trackArchive(async () => {
    try {
      if (hasArchiveCredentials) {
        await submitWaybackPost(link, {
          accessKey: env.archiveAccessKey ?? "",
          secretKey: env.archiveSecretKey ?? "",
        });
      } else {
        await submitWaybackGet(link);
      }

      if (isVerbose) {
        printStderr(`[verbose] archive: submitted ${link}`);
      }
    } catch (error) {
      if (!isVerbose) {
        return;
      }

      const reason = error instanceof Error ? error.message : "archive submission failed";
      printStderr(`[verbose] archive: failed for ${link} (${reason})`);
    }
  });
};

export const resetArchiveSubmitStateForTest = (): void => {
  anonymousHintShown = false;
};
