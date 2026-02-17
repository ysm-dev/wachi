import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";

const identifyRefsSchema = z.object({
  list_item_refs: z.array(z.string()),
  description: z.string(),
});

const truncateSnapshot = (snapshot: string, maxLength = 120_000): string => {
  if (snapshot.length <= maxLength) {
    return snapshot;
  }
  return snapshot.slice(0, maxLength);
};

export const identifyMainListRefs = async (
  model: LanguageModel,
  a11yTree: string,
): Promise<z.infer<typeof identifyRefsSchema>> => {
  const prompt = `Here is the accessibility tree:\n\n${truncateSnapshot(a11yTree)}\n\nIdentify the ref IDs of the main repeating content items (e.g. blog posts, news stories, product listings).`;

  const { object } = await generateObject({
    model,
    schema: identifyRefsSchema,
    system:
      "You are analyzing a web page accessibility tree. Identify the main repeating content list items.",
    prompt,
  });

  return object;
};
