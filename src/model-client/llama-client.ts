import { z } from 'zod';
import {
  TransportError,
  type CompletionRequest,
  type CompletionResponse,
  type ModelTransport,
} from './types.js';

export interface LlamaClientOptions {
  /** Base URL of the llama.cpp server, for example `http://127.0.0.1:8080`. */
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly requestTimeoutMs: number;
  /** Injectable for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * `response.json()` returns `any` — an assertion to this shape would only assume the server sent
 * what we expect, not check it. A malformed-but-valid-JSON reply (for example `choices` sent back
 * as a string) would then crash on the first optional-chained property access instead of being
 * reported as the `malformed` transport failure it already is below. Validating with a schema, the
 * same boundary-validation convention `src/core/config.ts` uses, turns that class of crash into
 * the existing graceful failure path.
 */
const chatCompletionBodySchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.unknown().optional() }).optional(),
        finish_reason: z.string().optional(),
      }),
    )
    .optional(),
  usage: z
    .object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() })
    .optional(),
  error: z.object({ message: z.string().optional() }).optional(),
});

type ChatCompletionBody = z.infer<typeof chatCompletionBodySchema>;

/**
 * llama.cpp-compatible transport using the server's OpenAI-shaped
 * `POST /v1/chat/completions` route.
 *
 * Retry policy lives in the broker, not here: this class classifies a failure as retryable or not
 * and lets the caller decide. That keeps "retry only for transient transport failures" a single
 * auditable decision rather than one spread across layers.
 */
export class LlamaCppClient implements ModelTransport {
  readonly #options: LlamaClientOptions;
  readonly #fetch: typeof fetch;

  constructor(options: LlamaClientOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const url = `${this.#options.endpoint.replace(/\/+$/, '')}/v1/chat/completions`;
    const timeoutSignal = AbortSignal.timeout(this.#options.requestTimeoutMs);
    const signal =
      request.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([timeoutSignal, request.signal]);

    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: false,
    };
    if (request.jsonSchema !== undefined) {
      body['response_format'] = {
        type: 'json_schema',
        json_schema: { name: 'semantic_verdict', strict: true, schema: request.jsonSchema },
      };
    }

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.#options.apiKey === undefined
            ? {}
            : { authorization: `Bearer ${this.#options.apiKey}` }),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (isAbort(error)) {
        // Distinguish "we timed out" from "the caller cancelled".
        const cancelled = request.signal?.aborted === true;
        throw new TransportError(
          cancelled ? 'Request cancelled by caller' : 'Request timed out',
          cancelled ? 'cancelled' : 'timeout',
          !cancelled,
          undefined,
          { cause: error },
        );
      }
      throw new TransportError(
        `Cannot reach the semantic service at ${url}: ${describe(error)}`,
        'network',
        true,
        undefined,
        { cause: error },
      );
    }

    if (!response.ok) {
      const detail = await safeText(response);
      throw new TransportError(
        `Semantic service returned HTTP ${response.status}: ${detail.slice(0, 300)}`,
        'http',
        isRetryableStatus(response.status),
        response.status,
      );
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error) {
      throw new TransportError(
        'Semantic service response was not valid JSON',
        'malformed',
        false,
        response.status,
        { cause: error },
      );
    }
    const shape = chatCompletionBodySchema.safeParse(raw);
    if (!shape.success) {
      throw new TransportError(
        'Semantic service response did not match the expected shape',
        'malformed',
        false,
        response.status,
        { cause: shape.error },
      );
    }
    const parsed: ChatCompletionBody = shape.data;

    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new TransportError(
        `Semantic service response had no message content${
          parsed.error?.message === undefined ? '' : `: ${parsed.error.message}`
        }`,
        'malformed',
        false,
        response.status,
      );
    }

    return {
      text: content,
      modelId: parsed.model ?? request.model,
      ...(parsed.usage?.prompt_tokens === undefined
        ? {}
        : { promptTokens: parsed.usage.prompt_tokens }),
      ...(parsed.usage?.completion_tokens === undefined
        ? {}
        : { completionTokens: parsed.usage.completion_tokens }),
    };
  }
}

/** 408, 429 and 5xx are transient. Every other 4xx is a client fault and is not retried. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError' || error.name === 'DOMException')
  );
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}
