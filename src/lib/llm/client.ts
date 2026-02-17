import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { getEnv } from "../../utils/env.ts";
import { WachiError } from "../../utils/error.ts";
import type { ResolvedConfig } from "../config/schema.ts";

const effectiveLlmConfigSchema = z.object({
  baseUrl: z.string(),
  apiKey: z.string(),
  model: z.string(),
});

export type EffectiveLlmConfig = z.infer<typeof effectiveLlmConfigSchema>;

export const resolveLlmConfig = (config: ResolvedConfig): EffectiveLlmConfig => {
  const env = getEnv();

  const baseUrl = env.llmBaseUrl ?? config.llm.base_url;
  const apiKey = env.llmApiKey ?? config.llm.api_key;
  const model = env.llmModel ?? config.llm.model;

  if (!apiKey || !model) {
    throw new WachiError(
      "LLM configuration required for non-RSS subscriptions.",
      "This URL has no RSS feed. wachi needs an LLM to identify content selectors.",
      `Set environment variables:\n  export WACHI_LLM_API_KEY="sk-..."\n  export WACHI_LLM_MODEL="gpt-4.1-mini"\n\nOr add to config:\n  llm:\n    api_key: "sk-..."\n    model: "gpt-4.1-mini"`,
    );
  }

  return {
    baseUrl,
    apiKey,
    model,
  };
};

export const createLlmModel = (config: EffectiveLlmConfig) => {
  const provider = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });

  return provider(config.model);
};
