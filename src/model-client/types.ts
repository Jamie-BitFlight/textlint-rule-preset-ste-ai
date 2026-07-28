/**
 * Transport contract for the semantic subsystem.
 *
 * This module knows about HTTP and nothing about controlled language. No rule logic, no
 * thresholds, no prompt content: those live in `src/semantic`. The boundary test in
 * `test/architecture` asserts that `model-client` never imports `semantic` or `deterministic`.
 */

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface CompletionRequest {
  readonly messages: readonly ChatMessage[];
  readonly model: string;
  readonly temperature: number;
  readonly maxTokens: number;
  /**
   * JSON Schema constraining the response. llama.cpp's OpenAI-compatible server honours
   * `response_format: { type: 'json_schema' }` by converting it to a GBNF grammar. Callers must
   * still validate the response: grammar-constrained output is not a guarantee of semantic
   * validity, and other servers ignore the field.
   */
  readonly jsonSchema?: unknown;
  readonly signal?: AbortSignal;
}

export interface CompletionResponse {
  readonly text: string;
  /** Model id reported by the server, or the requested id when the server omits it. */
  readonly modelId: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
}

export interface ModelTransport {
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

export type TransportFailureKind = 'network' | 'timeout' | 'cancelled' | 'http' | 'malformed';

export class TransportError extends Error {
  constructor(
    message: string,
    readonly kind: TransportFailureKind,
    /** True only for faults that a retry could plausibly resolve. */
    readonly retryable: boolean,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TransportError';
  }
}
