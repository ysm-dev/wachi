import { generateText } from "ai";
import { z } from "zod";

const summaryOptionsSchema = z.object({
  model: z.custom<Parameters<typeof generateText>[0]["model"]>(),
  prompt: z.string(),
  language: z.string(),
  markdown: z.string(),
});

type SummaryOptions = z.infer<typeof summaryOptionsSchema>;

export const summarizeMarkdown = async ({
  model,
  prompt,
  language,
  markdown,
}: SummaryOptions): Promise<string> => {
  const { text } = await generateText({
    model,
    system: `${prompt}\n\nRespond only in ${language}.`,
    prompt: markdown,
  });

  return text.trim();
};
