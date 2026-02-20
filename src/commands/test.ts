import { defineCommand } from "citty";
import { z } from "zod";
import { maskAppriseUrl, printJsonSuccess, printStderr, printStdout } from "../lib/cli/io.ts";
import { readConfig } from "../lib/config/read.ts";
import { isCssSubscription, isRssSubscription } from "../lib/config/schema.ts";
import { sendNotification } from "../lib/notify/send.ts";
import {
  normalizeAppriseUrlForIdentity,
  type SourceIdentity,
} from "../lib/notify/source-identity.ts";
import { fetchCssSubscriptionItems } from "../lib/subscriptions/fetch-css-subscription-items.ts";
import { fetchRssSubscriptionItems } from "../lib/subscriptions/fetch-rss-subscription-items.ts";
import { validateAppriseUrl } from "../lib/url/validate.ts";
import {
  commandJson,
  globalArgDefinitions,
  parseCommandArgs,
  runWithErrorHandling,
} from "./shared.ts";

const TEST_BODY =
  "wachi test notification -- if you see this, your notification channel is working.";

const testArgsSchema = z.object({
  appriseUrl: z.string().min(1),
  json: z.boolean().optional(),
  verbose: z.boolean().optional(),
  config: z.string().optional(),
});

const resolveTestSourceIdentity = async ({
  appriseUrl,
  configPath,
  verbose,
}: {
  appriseUrl: string;
  configPath?: string;
  verbose: boolean;
}): Promise<SourceIdentity | undefined> => {
  try {
    const configState = await readConfig(configPath);
    const exactMatch = configState.config.channels.find(
      (entry) => entry.apprise_url === appriseUrl,
    );
    const normalizedInput = normalizeAppriseUrlForIdentity(appriseUrl);
    const normalizedMatch = configState.config.channels.find(
      (entry) => normalizeAppriseUrlForIdentity(entry.apprise_url) === normalizedInput,
    );
    const channel = exactMatch ?? normalizedMatch;
    if (!channel || channel.subscriptions.length === 0) {
      return undefined;
    }

    let lastError: Error | null = null;
    for (const subscription of channel.subscriptions) {
      try {
        if (isRssSubscription(subscription)) {
          const fetched = await fetchRssSubscriptionItems({
            subscriptionUrl: subscription.url,
            rssUrl: subscription.rss_url,
            useConditionalRequest: false,
          });
          if (fetched.sourceIdentity?.username || fetched.sourceIdentity?.avatarUrl) {
            return fetched.sourceIdentity;
          }
          continue;
        }

        if (isCssSubscription(subscription)) {
          const fetched = await fetchCssSubscriptionItems(subscription);
          if (fetched.sourceIdentity?.username || fetched.sourceIdentity?.avatarUrl) {
            return fetched.sourceIdentity;
          }
        }
      } catch (error) {
        if (error instanceof Error) {
          lastError = error;
        }
      }
    }

    if (verbose && lastError) {
      printStderr(`[verbose] source branding skipped: ${lastError.message}`);
    }

    return undefined;
  } catch (error) {
    if (verbose && error instanceof Error) {
      printStderr(`[verbose] source branding skipped: ${error.message}`);
    }
    return undefined;
  }
};

export const testCommand = defineCommand({
  meta: {
    name: "test",
    description: "Send a test notification",
  },
  args: {
    ...globalArgDefinitions,
    appriseUrl: {
      type: "positional",
      required: true,
      description: "Apprise URL",
    },
  },
  run: async ({ args }) => {
    await runWithErrorHandling(args, async () => {
      const parsedArgs = parseCommandArgs(testArgsSchema, args);
      validateAppriseUrl(parsedArgs.appriseUrl);

      const sourceIdentity = await resolveTestSourceIdentity({
        appriseUrl: parsedArgs.appriseUrl,
        configPath: parsedArgs.config,
        verbose: parsedArgs.verbose === true,
      });

      if (parsedArgs.verbose) {
        if (sourceIdentity?.username || sourceIdentity?.avatarUrl) {
          const username = sourceIdentity.username ?? "<none>";
          const avatar = sourceIdentity.avatarUrl ?? "<none>";
          printStderr(`[verbose] test sender identity: username=${username}, avatar_url=${avatar}`);
        } else {
          printStderr(
            "[verbose] test sender identity: no matching subscription branding found; using channel defaults",
          );
        }
      }

      await sendNotification({
        appriseUrl: parsedArgs.appriseUrl,
        body: TEST_BODY,
        sourceIdentity,
      });

      if (commandJson(parsedArgs)) {
        printJsonSuccess({ sent: true });
      } else {
        printStdout(`Test notification sent to ${maskAppriseUrl(parsedArgs.appriseUrl)}`);
      }

      return 0;
    });
  },
});
