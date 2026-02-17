import { WachiError } from "../../utils/error.ts";
import { runBrowserCommand } from "./run.ts";

export const snapshotA11yTree = async (): Promise<string> => {
  const result = await runBrowserCommand(["snapshot", "--json"]);

  const trimmed = result.stdout.trim();
  if (!trimmed) {
    throw new WachiError(
      "Failed to capture accessibility snapshot",
      "agent-browser returned an empty snapshot.",
      "Try again or check if the target page loaded correctly.",
    );
  }

  return trimmed;
};
