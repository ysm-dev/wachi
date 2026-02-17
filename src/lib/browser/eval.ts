import { runBrowserCommand } from "./run.ts";

export const evalInBrowser = async (script: string): Promise<string> => {
  const result = await runBrowserCommand(["eval", script]);
  return result.stdout.trim();
};
