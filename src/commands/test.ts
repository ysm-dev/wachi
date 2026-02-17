import { defineCommand } from "citty";
import { z } from "zod";
import { maskAppriseUrl, printJsonSuccess, printStdout } from "../lib/cli/io.ts";
import { sendNotification } from "../lib/notify/send.ts";
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

      await sendNotification({ appriseUrl: parsedArgs.appriseUrl, body: TEST_BODY });

      if (commandJson(parsedArgs)) {
        printJsonSuccess({ sent: true });
      } else {
        printStdout(`Test notification sent to ${maskAppriseUrl(parsedArgs.appriseUrl)}`);
      }

      return 0;
    });
  },
});
