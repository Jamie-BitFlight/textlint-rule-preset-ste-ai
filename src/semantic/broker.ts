import type { SemanticConfig } from '../core/config.js';
import { contentHash } from '../core/text.js';
import type {
  CandidatePassage,
  SemanticFailure,
  SemanticOutcome,
  SemanticTrace,
  SemanticVerdict,
} from '../core/types.js';
import {
  MemorySemanticCache,
  NullSemanticCache,
  type SemanticCache,
} from '../model-client/cache.js';
import { TransportError, type ChatMessage, type ModelTransport } from '../model-client/types.js';
import { buildEvaluatorRequest, type EvaluatorRequest } from './evaluators.js';
import { FilePromptProvider } from './prompt-loader.js';
import { semanticVerdictJsonSchema, validateSemanticResponse } from './response-schema.js';

export interface SemanticBrokerDeps {
  readonly transport: ModelTransport;
  readonly promptProvider?: FilePromptProvider;
  readonly cache?: SemanticCache<SemanticVerdict>;
  /** Injectable clock for deterministic duration assertions in tests. */
  readonly now?: () => number;
  readonly trace?: (trace: SemanticTrace & { readonly detail?: string }) => void;
}

export interface BrokerStats {
  readonly requests: number;
  readonly cacheHits: number;
  readonly deduplicated: number;
  readonly failures: number;
  readonly repairs: number;
  readonly latenciesMs: readonly number[];
}

/**
 * The single gateway between rules and the model service.
 *
 * Rules never issue HTTP calls. They emit {@link CandidatePassage} values and this broker decides
 * whether, when and how often to ask a model. Centralising that gives one place to enforce
 * concurrency limits, request de-duplication, caching, timeouts, cancellation, schema validation,
 * the retry policy, and trace recording.
 */
export class SemanticBroker {
  readonly #config: SemanticConfig;
  readonly #transport: ModelTransport;
  readonly #prompts: FilePromptProvider;
  readonly #cache: SemanticCache<SemanticVerdict>;
  readonly #now: () => number;
  readonly #trace?: (trace: SemanticTrace & { readonly detail?: string }) => void;

  #requests = 0;
  #cacheHits = 0;
  #deduplicated = 0;
  #failures = 0;
  #repairs = 0;
  readonly #latencies: number[] = [];

  constructor(config: SemanticConfig, deps: SemanticBrokerDeps) {
    this.#config = config;
    this.#transport = deps.transport;
    this.#prompts = deps.promptProvider ?? new FilePromptProvider();
    this.#cache =
      deps.cache ??
      (config.cache
        ? new MemorySemanticCache<SemanticVerdict>()
        : new NullSemanticCache<SemanticVerdict>());
    this.#now = deps.now ?? (() => Date.now());
    if (deps.trace !== undefined) this.#trace = deps.trace;
  }

  get stats(): BrokerStats {
    return {
      requests: this.#requests,
      cacheHits: this.#cacheHits,
      deduplicated: this.#deduplicated,
      failures: this.#failures,
      repairs: this.#repairs,
      latenciesMs: [...this.#latencies],
    };
  }

  /**
   * Adjudicate a set of candidates.
   *
   * The returned array is in the same order as `candidates`, regardless of completion order, so
   * downstream diagnostics are stable. Candidates whose content hash is identical share one
   * request: that is the only batching performed, because it is the only kind that cannot change
   * an answer.
   */
  async adjudicate(
    candidates: readonly CandidatePassage[],
    signal?: AbortSignal,
  ): Promise<SemanticOutcome[]> {
    if (!this.#config.enabled) {
      return candidates.map((candidate) => this.#disabled(candidate));
    }

    const enabledEvaluators = new Set(this.#config.evaluators);
    const selected = candidates.filter(
      (c) => enabledEvaluators.size === 0 || enabledEvaluators.has(c.evaluatorId),
    );
    const skipped = new Set(candidates.filter((c) => !selected.includes(c)).map((c) => c.id));

    // Deterministic work order, independent of the caller's array order.
    const ordered = selected.toSorted((a, b) => a.id.localeCompare(b.id));

    const requests = new Map<string, EvaluatorRequest>();
    const hashByCandidate = new Map<string, string>();
    const buildFailures = new Map<string, SemanticFailure>();

    for (const candidate of ordered) {
      let request: EvaluatorRequest;
      try {
        request = buildEvaluatorRequest(candidate, this.#config, this.#prompts);
      } catch (error) {
        buildFailures.set(candidate.id, {
          kind: 'invalid-response',
          message: `prompt construction failed: ${error instanceof Error ? error.message : String(error)}`,
          attempts: 0,
        });
        continue;
      }
      hashByCandidate.set(candidate.id, request.contentHash);
      if (requests.has(request.contentHash)) {
        this.#deduplicated += 1;
        continue;
      }
      requests.set(request.contentHash, request);
    }

    const results = new Map<
      string,
      { verdict?: SemanticVerdict; failure?: SemanticFailure; trace: SemanticTrace }
    >();
    const queue = [...requests.values()];
    const workerCount = Math.max(1, Math.min(this.#config.maxConcurrency, queue.length));
    let cursor = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const request = queue[index];
        if (request === undefined) return;
        const outcome = await this.#execute(request, signal);
        results.set(request.contentHash, outcome);
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return candidates.map((candidate) => {
      if (skipped.has(candidate.id)) {
        return {
          kind: 'failure' as const,
          candidateId: candidate.id,
          failure: {
            kind: 'disabled' as const,
            message: `evaluator "${candidate.evaluatorId}" is not in the configured evaluator list`,
            attempts: 0,
          },
          trace: this.#emptyTrace(candidate, ''),
        };
      }
      const buildFailure = buildFailures.get(candidate.id);
      if (buildFailure !== undefined) {
        return {
          kind: 'failure' as const,
          candidateId: candidate.id,
          failure: buildFailure,
          trace: this.#emptyTrace(candidate, ''),
        };
      }
      const hash = hashByCandidate.get(candidate.id);
      const result = hash === undefined ? undefined : results.get(hash);
      if (result === undefined) {
        return {
          kind: 'failure' as const,
          candidateId: candidate.id,
          failure: { kind: 'transport' as const, message: 'no result produced', attempts: 0 },
          trace: this.#emptyTrace(candidate, hash ?? ''),
        };
      }
      const trace: SemanticTrace = { ...result.trace, candidateId: candidate.id };
      if (result.verdict !== undefined) {
        return {
          kind: 'verdict' as const,
          candidateId: candidate.id,
          verdict: result.verdict,
          trace,
        };
      }
      return {
        kind: 'failure' as const,
        candidateId: candidate.id,
        failure: result.failure ?? { kind: 'transport', message: 'unknown failure', attempts: 0 },
        trace,
      };
    });
  }

  #disabled(candidate: CandidatePassage): SemanticOutcome {
    return {
      kind: 'failure',
      candidateId: candidate.id,
      failure: { kind: 'disabled', message: 'semantic analysis is disabled', attempts: 0 },
      trace: this.#emptyTrace(candidate, ''),
    };
  }

  #emptyTrace(candidate: CandidatePassage, hash: string): SemanticTrace {
    return {
      candidateId: candidate.id,
      evaluatorId: candidate.evaluatorId,
      promptVersion: this.#config.promptVersion,
      modelId: this.#config.model,
      contentHash: hash,
      cacheHit: false,
      attempts: 0,
      durationMs: 0,
      repaired: false,
    };
  }

  async #execute(
    request: EvaluatorRequest,
    signal: AbortSignal | undefined,
  ): Promise<{ verdict?: SemanticVerdict; failure?: SemanticFailure; trace: SemanticTrace }> {
    const started = this.#now();
    const baseTrace = {
      candidateId: request.candidateId,
      evaluatorId: request.evaluatorId,
      promptVersion: request.promptVersion,
      modelId: this.#config.model,
      contentHash: request.contentHash,
    };

    const cached = this.#cache.get(request.contentHash);
    if (cached !== undefined) {
      this.#cacheHits += 1;
      const trace: SemanticTrace = {
        ...baseTrace,
        cacheHit: true,
        attempts: 0,
        durationMs: this.#now() - started,
        repaired: false,
      };
      this.#emit(trace, 'cache hit');
      return { verdict: cached, trace };
    }

    let attempts = 0;
    let repaired = false;
    let lastFailure: SemanticFailure | null = null;
    let messages: readonly ChatMessage[] = request.messages;

    // Transport attempts (retried) wrap validation attempts (repaired at most once).
    for (let repairRound = 0; repairRound <= this.#config.maxRepairAttempts; repairRound += 1) {
      let text: string | null = null;

      for (let attempt = 0; attempt <= this.#config.maxTransportRetries; attempt += 1) {
        if (signal?.aborted === true) {
          lastFailure = { kind: 'cancelled', message: 'run cancelled', attempts };
          text = null;
          break;
        }
        attempts += 1;
        this.#requests += 1;
        try {
          const response = await this.#transport.complete({
            messages,
            model: this.#config.model,
            temperature: this.#config.temperature,
            maxTokens: this.#config.maxOutputTokens,
            jsonSchema: semanticVerdictJsonSchema,
            ...(signal === undefined ? {} : { signal }),
          });
          text = response.text;
          break;
        } catch (error) {
          const failure = classifyTransportError(error, attempts);
          lastFailure = failure;
          const retryable = error instanceof TransportError && error.retryable;
          if (!retryable || attempt === this.#config.maxTransportRetries) break;
        }
      }

      if (text === null) break;

      const validation = validateSemanticResponse(text, {
        expectedRuleId: request.ruleId,
        passageLength: request.passageLength,
      });
      if (validation.ok) {
        this.#cache.set(request.contentHash, validation.verdict);
        const trace: SemanticTrace = {
          ...baseTrace,
          cacheHit: false,
          attempts,
          durationMs: this.#now() - started,
          repaired,
        };
        this.#emit(trace, `status=${validation.verdict.status}`);
        return { verdict: validation.verdict, trace };
      }

      lastFailure = { kind: validation.kind, message: validation.message, attempts };
      if (repairRound === this.#config.maxRepairAttempts) break;

      // Bounded repair: restate the contract and the fault, nothing else. No new task content.
      repaired = true;
      this.#repairs += 1;
      messages = [
        ...request.messages,
        { role: 'assistant', content: text },
        {
          role: 'user',
          content:
            `That response was rejected: ${validation.message}. ` +
            `Return only one JSON object with exactly these keys: ruleId (must be "${request.ruleId}"), ` +
            'status ("compliant" | "violation" | "uncertain"), confidence (number 0-1), ' +
            `evidenceStart and evidenceEnd (integers, 0 to ${request.passageLength}, start <= end), ` +
            'explanation (one short sentence), suggestedReplacements (array, may be empty), ' +
            'meaningPreserved (boolean). No other keys, no prose, no code fence.',
        },
      ];
    }

    this.#failures += 1;
    const trace: SemanticTrace = {
      ...baseTrace,
      cacheHit: false,
      attempts,
      durationMs: this.#now() - started,
      repaired,
    };
    this.#emit(trace, lastFailure?.message ?? 'unknown failure');
    return {
      failure: lastFailure ?? { kind: 'transport', message: 'unknown failure', attempts },
      trace,
    };
  }

  #emit(trace: SemanticTrace, detail: string): void {
    this.#latencies.push(trace.durationMs);
    if (this.#config.trace && this.#trace !== undefined) this.#trace({ ...trace, detail });
  }
}

export function classifyTransportError(error: unknown, attempts: number): SemanticFailure {
  if (error instanceof TransportError) {
    const kind =
      error.kind === 'timeout'
        ? 'timeout'
        : error.kind === 'cancelled'
          ? 'cancelled'
          : error.kind === 'malformed'
            ? 'invalid-response'
            : 'transport';
    return { kind, message: error.message, attempts };
  }
  return {
    kind: 'transport',
    message: error instanceof Error ? error.message : String(error),
    attempts,
  };
}

/** Exported for the cache-key contract test. */
export function requestCacheKey(parts: readonly string[]): string {
  return contentHash(...parts);
}
