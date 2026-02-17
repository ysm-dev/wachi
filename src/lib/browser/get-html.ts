import { runBrowserCommand } from "./run.ts";

export const getBrowserHtml = async (): Promise<string> => {
  const result = await runBrowserCommand(["get-html"]);
  return result.stdout;
};
