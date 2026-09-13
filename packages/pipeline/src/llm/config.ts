/**
 * Single constant home for the LLM model name and outbound limits.
 * Every Groq call in this repo references LLM_MODEL; never hardcode a model string elsewhere.
 */

/** Model id used for every call. Switch providers by updating this single constant. */
export const LLM_MODEL = process.env.LLM_MODEL ?? "openai/gpt-oss-120b";

/** Base URL for the OpenAI-compatible endpoint (append /chat/completions). */
export const GROQ_BASE_URL = (process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/$/, "");

/** Read the API key; callers can override per-call, but this is the canonical source. */
export function llmApiKey(override?: string): string {
  return override ?? process.env.GROQ_API_KEY ?? "";
}

/**
 * Canonical shared token-bucket rate (tokens-per-second) for ALL outbound calls
 * (search API and LLM) so they share ONE limiter.
 *
 * 130 tokens/s ≈ 7,800 tokens/min ≈ safe ceiling under the Groq free-tier TPM
 * limit (8,000 combined in+out) with headroom for Tavily and retries. Each LLM
 * call charges ceil(estTokens) bucket-tokens so total outbound throughput
 * stays under 130/s; search charges a flat 1 and is effectively unthrottled.
 */
export const OUTBOUND_RATE = 130;

/** Burst cap for the shared token bucket. */
export const OUTBOUND_BURST = 100;