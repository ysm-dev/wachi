import { fetchArticleHtml } from "../article/fetch.ts";
import { getReadingTimeMinutes } from "../article/reading-time.ts";
import { htmlToMarkdown } from "../article/to-markdown.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { createLlmModel, resolveLlmConfig } from "../llm/client.ts";
import { summarizeMarkdown } from "../llm/summarize.ts";

export const buildItemSummary = async (
  itemLink: string,
  config: ResolvedConfig,
  verbose: boolean,
): Promise<string | null> => {
  if (!config.summary.enabled) {
    return null;
  }

  try {
    const html = await fetchArticleHtml(itemLink);
    const markdown = htmlToMarkdown(html);
    const minutes = getReadingTimeMinutes(markdown);

    if (minutes < config.summary.min_reading_time) {
      return null;
    }

    const llm = resolveLlmConfig(config);
    const model = createLlmModel(llm);
    const summary = await summarizeMarkdown({
      model,
      prompt: config.summary.prompt,
      language: config.summary.language,
      markdown,
    });

    return summary || null;
  } catch (error) {
    if (verbose && error instanceof Error) {
      process.stderr.write(`[verbose] summary skipped: ${error.message}\n`);
    }
    return null;
  }
};
