import { z } from "zod";
import { closeBrowserPage } from "../browser/close.ts";
import { getBrowserHtml } from "../browser/get-html.ts";
import { ensureAgentBrowserInstalled } from "../browser/install.ts";
import { openBrowserPage } from "../browser/open.ts";
import { snapshotA11yTree } from "../browser/snapshot.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { http } from "../http/client.ts";
import { createLlmModel, resolveLlmConfig } from "../llm/client.ts";
import { deriveSelectorsFromHtml } from "../llm/derive-selectors.ts";
import { identifyMainListRefs } from "../llm/identify-refs.ts";
import { cssSelectorsSchema } from "./extract.ts";
import { validateCssSelectors } from "./validate.ts";

const identifyResultSchema = z.object({
  selectors: cssSelectorsSchema,
  warning: z.string().optional(),
});

type IdentifyResult = z.infer<typeof identifyResultSchema>;

export const identifyCssSelectors = async (
  url: string,
  config: ResolvedConfig,
): Promise<IdentifyResult> => {
  const llm = resolveLlmConfig(config);
  const model = createLlmModel(llm);

  await ensureAgentBrowserInstalled();
  let browserHtml = "";

  try {
    await openBrowserPage(url);
    const snapshot = await snapshotA11yTree();
    await identifyMainListRefs(model, snapshot);
    browserHtml = await getBrowserHtml();
  } finally {
    await closeBrowserPage();
  }

  if (!browserHtml.trim()) {
    const response = await http.raw(url, { responseType: "text" });
    browserHtml = typeof response._data === "string" ? response._data : "";
  }

  const selectors = deriveSelectorsFromHtml(browserHtml);

  const response = await http.raw(url, { responseType: "text" });
  const rawHtml = typeof response._data === "string" ? response._data : "";
  const valid = validateCssSelectors(rawHtml, url, selectors);

  if (!valid) {
    return {
      selectors,
      warning:
        "Warning: This site appears to require JavaScript rendering. CSS selector monitoring may not work reliably. Subscription created, but checks may fail.",
    };
  }

  return { selectors };
};
