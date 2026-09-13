/**
 * Single LLM client for the whole pipeline. Wraps Groq's OpenAI-compatible
 * chat completions endpoint with:
 *  - strict structured outputs (response_format json_schema) when a schema is given,
 *  - HTTP retry with the SAME exponential backoff as fetchPage (shared helper),
 *  - one JSON repair retry, then a typed PipelineError — never garbage passthrough,
 *  - token-aware pacing through the sharedRateLimitedQueue (one limiter everywhere).
 *
 * Every call is wrapped: an LLM failure surfaces as a typed PipelineError so
 * orchestrators record-and-continue exactly like a retrieval failure.
 */
import { exponentialBackoffMs, sleep } from "../lib/util";
import { PipelineError } from "../errors";
import { sharedRateLimitedQueue } from "../retrieval/rateLimit";
import { GROQ_BASE_URL, llmApiKey, LLM_MODEL, OUTBOUND_BURST, OUTBOUND_RATE } from "./config";
import { matchesShape, type JsonSchema } from "./shape";

export interface LLMCallOptions {
  system?: string;
  /** Strict-mode JSON schema for the response (Groq structured outputs). */
  schema?: JsonSchema;
  /** Schema name used in the response_format envelope. */
  schemaName?: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * GPT-OSS models emit chain-of-thought in message.reasoning BEFORE content.
   * "low" keeps that minimal for structured tasks (strict JSON constrained
   * decoding can otherwise eat the whole max_tokens budget on reasoning).
   */
  reasoningEffort?: "low" | "medium" | "high";
  /** HTTP retry budget for 429/5xx/network failures. */
  retries?: number;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** If prompt exceeds maxInputChars, trim (compact reading keeps TPM low). */
  maxInputChars?: number;
}

export interface LLMCallMetrics {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Chain-of-thought tokens (GPT-OSS family). Included in completionTokens. */
  reasoningTokens: number;
  /** Wall-clock including retries/backoff. */
  durationMs: number;
  /** HTTP attempts made (1 = no retry). */
  attempts: number;
  /** True when the JSON repair re-send was used. */
  repairUsed: boolean;
  cachedTokens?: number;
}

export interface LLMCallResult {
  text: string;
  /** Parsed JSON, or null if the response was not JSON. */
  json: unknown;
  metrics: LLMCallMetrics;
}

const DEFAULT_MAX_TOKENS = 900;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_RETRIES = 3;
const DEFAULT_REASONING_EFFORT = "low";

function fail(code: string, message: string): never {
  throw new PipelineError(message, code, "llm");
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil((text?.length ?? 0) / 4));
}

export async function callLLM(prompt: string, options: LLMCallOptions = {}): Promise<LLMCallResult> {
  const apiKey = llmApiKey(options.apiKey);
  if (!apiKey) fail("LLM_API_KEY_MISSING", "GROQ_API_KEY is not set (or passed as options.apiKey)");

  const model = options.model ?? LLM_MODEL;
  const baseUrl = options.baseUrl ?? GROQ_BASE_URL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  const maxInputChars = options.maxInputChars ?? 4000;
  const trimmed = prompt.length > maxInputChars ? prompt.slice(0, maxInputChars) : prompt;

  const schema = options.schema;
  const responseFormat = schema
    ? {
        type: "json_schema" as const,
        json_schema: {
          name: options.schemaName ?? "structured_response",
          strict: true,
          schema,
        },
      }
    : undefined;

  const messages = [
    ...(options.system ? [{ role: "system" as const, content: options.system }] : []),
    { role: "user" as const, content: trimmed },
  ];

  // Charge the shared token bucket for the estimated cost of this call so total
  // outbound throughput stays under the free-tier TPM ceiling.
  const estTokens = estimateTokens(trimmed) + estimateTokens(options.system ?? "") + maxTokens;
  const queue = sharedRateLimitedQueue(OUTBOUND_RATE, OUTBOUND_BURST);
  return queue.run(() => sendWithRetries(messages, responseFormat, { apiKey, model, baseUrl, maxTokens, temperature, retries: options.retries ?? DEFAULT_RETRIES, reasoningEffort: options.reasoningEffort ?? DEFAULT_REASONING_EFFORT, schema }), estTokens);
}

interface SendEnvelope {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxTokens: number;
  temperature: number;
  retries: number;
  reasoningEffort: "low" | "medium" | "high";
  schema?: JsonSchema;
}

type GroqMessage = { role: "system" | "user"; content: string };

async function sendWithRetries(
  initialMessages: GroqMessage[],
  responseFormat: { type: "json_schema"; json_schema: { name: string; strict: boolean; schema: JsonSchema | undefined } } | undefined,
  env: SendEnvelope,
): Promise<LLMCallResult> {
  const started = Date.now();
  let attempts = 0;
  let repairUsed = false;

  const strictInstruction =
    "\n\nReturn ONLY a single JSON object (no prose, no markdown fences, no trailing text) matching EXACTLY this shape:\n" +
    JSON.stringify(env.schema);
  const bareJsonInstruction = "\n\nReturn ONLY valid JSON (no prose, no markdown fences, no trailing text).";

  // Repair path re-sends with the strict instruction appended and switches strict
  // constrained decoding OFF (best-effort) — a strict 400 can't self-heal otherwise.
  const trySend = async (messages: GroqMessage[], fmt: typeof responseFormat): Promise<LLMCallResult> => {
    while (true) {
      attempts++;
      const body: Record<string, unknown> = {
        model: env.model,
        messages,
        max_tokens: env.maxTokens,
        temperature: env.temperature,
        reasoning_effort: env.reasoningEffort,
      };
      if (fmt) body.response_format = fmt;

      try {
        const res = await fetch(`${env.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${env.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const reason = await res.text().catch(() => "");
          const retryable = res.status === 429 || res.status >= 500;
          if (!retryable) {
            if (res.status === 401) fail("LLM_AUTH_FAILED", `Groq 401 Unauthorized — key invalid or not enabled for ${env.model}. ${reason.slice(0, 300)}`);
            if (res.status === 404) fail("LLM_MODEL_UNAVAILABLE", `Groq 404 — model "${env.model}" not available on this account. ${reason.slice(0, 300)}`);
            fail("LLM_HTTP_ERROR", `Groq HTTP ${res.status}: ${reason.slice(0, 300)}`);
          }
          if (attempts <= env.retries) {
            const retryAfter = res.headers.get("retry-after");
            const wait = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : undefined;
            if (wait) await sleep(Math.min(wait, 8000));
            else await sleep(exponentialBackoffMs(attempts));
            continue;
          }
          fail("LLM_RATE_LIMITED", `Groq ${res.status} after ${env.retries} retries (rate/credit limited). ${reason.slice(0, 300)}`);
        }

        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number }; prompt_tokens_details?: { cached_tokens?: number } };
        };
        const text = json.choices?.[0]?.message?.content ?? "";

        let parsed: unknown = null;
        let parseOk = false;
        if (text.trim()) {
          try {
            parsed = JSON.parse(text.trim());
            parseOk = true;
          } catch {
            parseOk = false;
          }
        }

        const shapeBad = parseOk && env.schema ? !matchesShape(parsed, env.schema).ok : false;

        if (parseOk && !shapeBad) {
          return {
            text,
            json: parsed,
            metrics: {
              model: env.model,
              promptTokens: json.usage?.prompt_tokens ?? 0,
              completionTokens: json.usage?.completion_tokens ?? 0,
              totalTokens: json.usage?.total_tokens ?? 0,
              reasoningTokens: json.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
              cachedTokens: json.usage?.prompt_tokens_details?.cached_tokens,
              durationMs: Date.now() - started,
              attempts,
              repairUsed,
            },
          };
        }

        // Invalid JSON or shape mismatch: exactly one stricter repair re-send.
        if (!repairUsed) {
          repairUsed = true;
          const lastContent = messages[messages.length - 1]!.content;
          const repairMessages: GroqMessage[] = [
            ...messages.slice(0, messages.length - 1),
            { role: "user", content: env.schema ? `${lastContent}${strictInstruction}` : `${lastContent}${bareJsonInstruction}` },
          ];
          const relaxedFmt = env.schema
            ? ({ type: "json_schema", json_schema: { name: "structured_response", strict: false, schema: env.schema } } as const)
            : undefined;
          return trySend(repairMessages, relaxedFmt);
        }

        fail("LLM_INVALID_RESPONSE", `Groq returned non-JSON or schema-mismatched content even after one strict repair. response: ${text.slice(0, 300)}`);
      } catch (err) {
        if (err instanceof PipelineError) throw err;
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || /timeout/i.test(err.message ?? ""));
        const code = timedOut ? "LLM_TIMEOUT" : err instanceof TypeError ? "LLM_NETWORK_ERROR" : "LLM_CALL_FAILED";
        if (attempts <= env.retries) {
          await sleep(exponentialBackoffMs(attempts));
          continue;
        }
        fail(code, err instanceof Error ? err.message : String(err));
      }
    }
  };

  return trySend(initialMessages, responseFormat);
}