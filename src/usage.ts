import type { Meters } from './cost';

/**
 * Provider usage adapters: each maps a provider's `usage` block onto the canonical meters.
 * The provider is chosen by config (cdk.json `modelProvider`), never guessed from the response.
 * An adapter returns undefined when the block is missing or malformed: never guess a cost.
 */
export const PROVIDERS = ['deepseek', 'openai', 'anthropic', 'gemini'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const isProvider = (v: unknown): v is Provider => PROVIDERS.includes(v as Provider);

const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;

/**
 * Shared OpenAI-shape logic: prompt_tokens includes cached tokens, completion_tokens includes
 * reasoning tokens. Both are split out so the meters never overlap.
 */
function fromOpenAiShape(u: Record<string, any>, cached: number, reasoningIncluded = true): Meters | undefined {
  const prompt = count(u.prompt_tokens);
  const completion = count(u.completion_tokens);
  if (prompt === undefined || completion === undefined) return undefined;
  const cacheReadTokens = Math.min(cached, prompt);
  const reasoning = count(u.completion_tokens_details?.reasoning_tokens) ?? 0;
  const reasoningTokens = reasoningIncluded ? Math.min(reasoning, completion) : reasoning;
  return {
    inputTokens: prompt - cacheReadTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    outputTokens: reasoningIncluded ? completion - reasoningTokens : completion,
    reasoningTokens,
  };
}

/** DeepSeek: prompt_cache_hit_tokens / prompt_cache_miss_tokens; reasoner adds reasoning_tokens. */
function deepseek(u: Record<string, any>): Meters | undefined {
  return fromOpenAiShape(u, count(u.prompt_cache_hit_tokens) ?? count(u.prompt_tokens_details?.cached_tokens) ?? 0);
}

/** OpenAI-compatible: prompt_tokens_details.cached_tokens, completion_tokens_details.reasoning_tokens. */
function openai(u: Record<string, any>): Meters | undefined {
  return fromOpenAiShape(u, count(u.prompt_tokens_details?.cached_tokens) ?? 0);
}

/**
 * Anthropic Messages API: input_tokens already excludes cache reads and writes; thinking tokens
 * are billed and reported inside output_tokens, so reasoning stays 0.
 */
function anthropic(u: Record<string, any>): Meters | undefined {
  const input = count(u.input_tokens);
  const output = count(u.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  return {
    inputTokens: input,
    cacheReadTokens: count(u.cache_read_input_tokens) ?? 0,
    cacheWriteTokens: count(u.cache_creation_input_tokens) ?? 0,
    outputTokens: output,
    reasoningTokens: 0,
  };
}

/**
 * Gemini's OpenAI-compatible endpoint. Thinking tokens may be reported either inside
 * completion_tokens (OpenAI convention) or beside it; total_tokens tells which: if
 * total = prompt + completion + reasoning, they were not included in completion_tokens.
 */
function gemini(u: Record<string, any>): Meters | undefined {
  const prompt = count(u.prompt_tokens);
  const completion = count(u.completion_tokens);
  const reasoning = count(u.completion_tokens_details?.reasoning_tokens) ?? 0;
  const separate = reasoning > 0 && prompt !== undefined && completion !== undefined &&
    count(u.total_tokens) === prompt + completion + reasoning;
  return fromOpenAiShape(u, count(u.prompt_tokens_details?.cached_tokens) ?? 0, !separate);
}

const ADAPTERS: Record<Provider, (u: Record<string, any>) => Meters | undefined> = { deepseek, openai, anthropic, gemini };

export function metersFromUsage(provider: Provider, usage: unknown): Meters | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined;
  return ADAPTERS[provider](usage as Record<string, any>);
}

/** Meters the app states itself (an estimate): inputTokens and outputTokens, the rest optional (0). */
export function canonicalMeters(u: Record<string, unknown>): Meters | undefined {
  const m = {
    inputTokens: count(u.inputTokens),
    cacheReadTokens: count(u.cacheReadTokens ?? 0),
    cacheWriteTokens: count(u.cacheWriteTokens ?? 0),
    outputTokens: count(u.outputTokens),
    reasoningTokens: count(u.reasoningTokens ?? 0),
  };
  return Object.values(m).includes(undefined) ? undefined : (m as Meters);
}
