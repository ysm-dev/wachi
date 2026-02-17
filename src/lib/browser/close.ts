import { runBrowserCommand } from "./run.ts";

export const closeBrowserPage = async (): Promise<void> => {
  try {
    await runBrowserCommand(["close"]);
  } catch {
    return;
  }
};
