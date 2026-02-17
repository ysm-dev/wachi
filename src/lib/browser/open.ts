import { runBrowserCommand } from "./run.ts";

export const openBrowserPage = async (url: string): Promise<void> => {
  await runBrowserCommand(["open", url]);
};
