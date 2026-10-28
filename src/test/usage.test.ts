import { isProvider, metersFromUsage } from '../usage';

describe('DeepSeek adapter', () => {
  test('splits cache hits from misses', () => {
    expect(
      metersFromUsage('deepseek', { prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 }),
    ).toEqual({ inputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 0, outputTokens: 50, reasoningTokens: 0 });
  });

  test('takes reasoning tokens out of completion tokens (reasoner models)', () => {
    expect(
      metersFromUsage('deepseek', {
        prompt_tokens: 10, completion_tokens: 300, prompt_cache_hit_tokens: 0,
        completion_tokens_details: { reasoning_tokens: 250 },
      }),
    ).toEqual({ inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50, reasoningTokens: 250 });
  });

  test('treats missing cache info as all uncached and clamps nonsense', () => {
    expect(metersFromUsage('deepseek', { prompt_tokens: 100, completion_tokens: 10 })!.inputTokens).toBe(100);
    expect(metersFromUsage('deepseek', { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 500 })).toMatchObject({
      inputTokens: 0, cacheReadTokens: 100,
    });
  });
});

describe('OpenAI-compatible adapter', () => {
  test('reads cached_tokens and reasoning_tokens', () => {
    expect(
      metersFromUsage('openai', {
        prompt_tokens: 100, completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 60 },
        completion_tokens_details: { reasoning_tokens: 30 },
      }),
    ).toEqual({ inputTokens: 40, cacheReadTokens: 60, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 30 });
  });

  test('ignores DeepSeek-only fields', () => {
    expect(metersFromUsage('openai', { prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 90 })!.cacheReadTokens).toBe(0);
  });
});

describe('Anthropic adapter', () => {
  test('input_tokens already excludes cache reads and writes', () => {
    expect(
      metersFromUsage('anthropic', {
        input_tokens: 25, output_tokens: 300, cache_creation_input_tokens: 2000, cache_read_input_tokens: 8000,
      }),
    ).toEqual({ inputTokens: 25, cacheReadTokens: 8000, cacheWriteTokens: 2000, outputTokens: 300, reasoningTokens: 0 });
  });

  test('cache fields are optional', () => {
    expect(metersFromUsage('anthropic', { input_tokens: 5, output_tokens: 6 })).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  test('OpenAI-shape usage is not Anthropic usage', () => {
    expect(metersFromUsage('anthropic', { prompt_tokens: 5, completion_tokens: 6 })).toBeUndefined();
  });
});

describe('Gemini OpenAI-compat adapter', () => {
  test('reasoning reported beside completion tokens (total = prompt + completion + reasoning)', () => {
    expect(
      metersFromUsage('gemini', {
        prompt_tokens: 100, completion_tokens: 20, total_tokens: 170,
        completion_tokens_details: { reasoning_tokens: 50 },
      }),
    ).toEqual({ inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20, reasoningTokens: 50 });
  });

  test('reasoning included in completion tokens (OpenAI convention)', () => {
    expect(
      metersFromUsage('gemini', {
        prompt_tokens: 100, completion_tokens: 70, total_tokens: 170,
        prompt_tokens_details: { cached_tokens: 40 },
        completion_tokens_details: { reasoning_tokens: 50 },
      }),
    ).toEqual({ inputTokens: 60, cacheReadTokens: 40, cacheWriteTokens: 0, outputTokens: 20, reasoningTokens: 50 });
  });

  test('plain usage without details', () => {
    expect(metersFromUsage('gemini', { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 })).toEqual({
      inputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 3, reasoningTokens: 0,
    });
  });
});

test.each(['deepseek', 'openai', 'anthropic', 'gemini'] as const)('%s rejects missing or malformed usage', (provider) => {
  expect(metersFromUsage(provider, undefined)).toBeUndefined();
  expect(metersFromUsage(provider, null)).toBeUndefined();
  expect(metersFromUsage(provider, { prompt_tokens: 1.5, completion_tokens: 1, input_tokens: 1.5, output_tokens: 1 })).toBeUndefined();
  expect(metersFromUsage(provider, { prompt_tokens: -1, completion_tokens: 1, input_tokens: -1, output_tokens: 1 })).toBeUndefined();
  expect(metersFromUsage(provider, { completion_tokens: 1, output_tokens: 1 })).toBeUndefined();
});

test('isProvider', () => {
  expect(isProvider('deepseek')).toBe(true);
  expect(isProvider('mistral')).toBe(false);
});
