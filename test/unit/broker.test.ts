import { describe, expect, it } from 'vitest';
import { semanticConfigSchema } from '../../src/core/config.js';
import type { CandidatePassage, SemanticVerdict } from '../../src/core/types.js';
import { MemorySemanticCache } from '../../src/model-client/cache.js';
import { TransportError } from '../../src/model-client/types.js';
import { SemanticBroker } from '../../src/semantic/broker.js';
import { ScriptedTransport, verdictJson } from '../helpers/fake-semantic-service.js';

function config(overrides: Record<string, unknown> = {}) {
  return semanticConfigSchema.parse({ enabled: true, maxRepairAttempts: 0, ...overrides });
}

function candidate(id: string, overrides: Partial<CandidatePassage> = {}): CandidatePassage {
  return {
    id,
    ruleId: 'one-instruction-per-sentence',
    evaluatorId: 'one-instruction-per-sentence',
    range: { start: 0, end: 10 },
    passage: 'Remove the cover and install the filter.',
    passageOffset: 0,
    payload: { candidateVerbs: ['Remove', 'install'] },
    invariants: ['action order'],
    reason: 'test',
    mode: 'procedural',
    admonition: 'none',
    ...overrides,
  };
}

const VERDICT = verdictJson({ ruleId: 'one-instruction-per-sentence' });

describe('SemanticBroker — disabled', () => {
  it('makes no requests and reports every candidate as disabled', async () => {
    const transport = new ScriptedTransport([]);
    const broker = new SemanticBroker(semanticConfigSchema.parse({ enabled: false }), {
      transport,
    });
    const outcomes = await broker.adjudicate([candidate('a'), candidate('b')]);
    expect(transport.requests).toHaveLength(0);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.kind === 'failure' && o.failure.kind === 'disabled')).toBe(true);
  });
});

describe('SemanticBroker — ordering and identity', () => {
  it("returns outcomes in the caller's order regardless of completion order", async () => {
    const transport = new ScriptedTransport(
      [
        {
          content: verdictJson({ ruleId: 'one-instruction-per-sentence', explanation: 'first' }),
          delayMs: 30,
        },
        {
          content: verdictJson({ ruleId: 'one-instruction-per-sentence', explanation: 'second' }),
          delayMs: 0,
        },
      ],
      { content: VERDICT },
    );
    const broker = new SemanticBroker(config({ maxConcurrency: 2 }), { transport });
    const candidates = [
      candidate('a', { passage: 'A distinct passage one.' }),
      candidate('b', { passage: 'A distinct passage two.' }),
    ];
    const outcomes = await broker.adjudicate(candidates);
    expect(outcomes.map((o) => o.candidateId)).toEqual(['a', 'b']);
  });

  it('de-duplicates identical questions into one request', async () => {
    const transport = new ScriptedTransport([], { content: VERDICT });
    const broker = new SemanticBroker(config(), { transport });
    const outcomes = await broker.adjudicate([candidate('a'), candidate('b'), candidate('c')]);
    expect(transport.requests).toHaveLength(1);
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((o) => o.kind === 'verdict')).toBe(true);
    expect(broker.stats.deduplicated).toBe(2);
  });

  it('sends distinct requests for distinct passages', async () => {
    const transport = new ScriptedTransport([], { content: VERDICT });
    const broker = new SemanticBroker(config(), { transport });
    await broker.adjudicate([
      candidate('a', { passage: 'Passage one.' }),
      candidate('b', { passage: 'Passage two.' }),
    ]);
    expect(transport.requests).toHaveLength(2);
  });
});

describe('SemanticBroker — concurrency', () => {
  it('never exceeds the configured concurrency', async () => {
    const transport = new ScriptedTransport([], { content: VERDICT, delayMs: 20 });
    const broker = new SemanticBroker(config({ maxConcurrency: 2 }), { transport });
    const candidates = Array.from({ length: 8 }, (_, i) =>
      candidate(`c${i}`, { passage: `Passage number ${i}.` }),
    );
    await broker.adjudicate(candidates);
    expect(transport.requests).toHaveLength(8);
    expect(transport.peakConcurrency).toBeLessThanOrEqual(2);
    expect(transport.peakConcurrency).toBeGreaterThan(1);
  });
});

describe('SemanticBroker — caching', () => {
  it('serves a repeated question from cache without a second request', async () => {
    const transport = new ScriptedTransport([], { content: VERDICT });
    const cache = new MemorySemanticCache<SemanticVerdict>();
    const broker = new SemanticBroker(config(), { transport, cache });
    await broker.adjudicate([candidate('a')]);
    await broker.adjudicate([candidate('a2')]);
    expect(transport.requests).toHaveLength(1);
    expect(broker.stats.cacheHits).toBe(1);
  });

  it('misses the cache when the model changes', async () => {
    const transport = new ScriptedTransport([], { content: VERDICT });
    const cache = new MemorySemanticCache<SemanticVerdict>();
    const a = new SemanticBroker(config({ model: 'model-a' }), { transport, cache });
    const b = new SemanticBroker(config({ model: 'model-b' }), { transport, cache });
    await a.adjudicate([candidate('a')]);
    await b.adjudicate([candidate('a')]);
    expect(transport.requests).toHaveLength(2);
  });

  it('honours cache: false', async () => {
    const transport = new ScriptedTransport([], { content: VERDICT });
    const broker = new SemanticBroker(config({ cache: false }), { transport });
    await broker.adjudicate([candidate('a')]);
    await broker.adjudicate([candidate('a2')]);
    expect(transport.requests).toHaveLength(2);
  });
});

describe('SemanticBroker — retry policy', () => {
  it('retries a transient transport failure', async () => {
    const transport = new ScriptedTransport([
      { error: new TransportError('boom', 'network', true) },
      { content: VERDICT },
    ]);
    const broker = new SemanticBroker(config({ maxTransportRetries: 2 }), { transport });
    const [outcome] = await broker.adjudicate([candidate('a')]);
    expect(outcome?.kind).toBe('verdict');
    expect(transport.requests).toHaveLength(2);
  });

  it('does not retry a non-retryable HTTP failure', async () => {
    const transport = new ScriptedTransport([
      { error: new TransportError('bad request', 'http', false, 400) },
    ]);
    const broker = new SemanticBroker(config({ maxTransportRetries: 3 }), { transport });
    const [outcome] = await broker.adjudicate([candidate('a')]);
    expect(transport.requests).toHaveLength(1);
    expect(outcome?.kind).toBe('failure');
  });

  it('does not retry invalid output as a transport fault', async () => {
    const transport = new ScriptedTransport([], { content: 'not json at all' });
    const broker = new SemanticBroker(config({ maxTransportRetries: 3, maxRepairAttempts: 0 }), {
      transport,
    });
    const [outcome] = await broker.adjudicate([candidate('a')]);
    expect(transport.requests).toHaveLength(1);
    expect(outcome?.kind).toBe('failure');
    if (outcome?.kind === 'failure') expect(outcome.failure.kind).toBe('invalid-response');
  });

  it('gives up after the configured retry budget', async () => {
    const transport = new ScriptedTransport([], {
      error: new TransportError('down', 'network', true),
    });
    const broker = new SemanticBroker(config({ maxTransportRetries: 2 }), { transport });
    const [outcome] = await broker.adjudicate([candidate('a')]);
    expect(transport.requests).toHaveLength(3);
    expect(outcome?.kind).toBe('failure');
  });
});

describe('SemanticBroker — bounded repair', () => {
  it('re-asks once when output fails validation and accepts the repaired answer', async () => {
    const transport = new ScriptedTransport([{ content: '{"nope": true}' }, { content: VERDICT }]);
    const broker = new SemanticBroker(config({ maxRepairAttempts: 1 }), { transport });
    const [outcome] = await broker.adjudicate([candidate('a')]);
    expect(outcome?.kind).toBe('verdict');
    expect(transport.requests).toHaveLength(2);
    expect(outcome?.trace.repaired).toBe(true);
    // The repair prompt restates the contract and adds no new task content.
    const repairMessages = transport.requests[1]?.messages ?? [];
    expect(repairMessages[repairMessages.length - 1]?.content).toContain('was rejected');
  });

  it('never repairs more than the configured budget', async () => {
    const transport = new ScriptedTransport([], { content: '{"nope": true}' });
    const broker = new SemanticBroker(config({ maxRepairAttempts: 1 }), { transport });
    const [outcome] = await broker.adjudicate([candidate('a')]);
    expect(transport.requests).toHaveLength(2);
    expect(outcome?.kind).toBe('failure');
  });

  it('does not repair when the budget is zero', async () => {
    const transport = new ScriptedTransport([], { content: '{"nope": true}' });
    const broker = new SemanticBroker(config({ maxRepairAttempts: 0 }), { transport });
    await broker.adjudicate([candidate('a')]);
    expect(transport.requests).toHaveLength(1);
  });
});

describe('SemanticBroker — cancellation and timeout', () => {
  it('reports cancellation when the signal is already aborted', async () => {
    const transport = new ScriptedTransport([], { content: VERDICT });
    const broker = new SemanticBroker(config(), { transport });
    const controller = new AbortController();
    controller.abort();
    const [outcome] = await broker.adjudicate([candidate('a')], controller.signal);
    expect(transport.requests).toHaveLength(0);
    expect(outcome?.kind).toBe('failure');
    if (outcome?.kind === 'failure') expect(outcome.failure.kind).toBe('cancelled');
  });

  it('classifies a timeout as a timeout, not as invalid output', async () => {
    const transport = new ScriptedTransport([], {
      error: new TransportError('Request timed out', 'timeout', true),
    });
    const broker = new SemanticBroker(config({ maxTransportRetries: 0 }), { transport });
    const [outcome] = await broker.adjudicate([candidate('a')]);
    expect(outcome?.kind).toBe('failure');
    if (outcome?.kind === 'failure') expect(outcome.failure.kind).toBe('timeout');
  });
});

describe('SemanticBroker — evaluator selection and tracing', () => {
  it('skips evaluators that are not in the configured list', async () => {
    const transport = new ScriptedTransport([], { content: VERDICT });
    const broker = new SemanticBroker(config({ evaluators: ['passive-voice-adjudication'] }), {
      transport,
    });
    const [outcome] = await broker.adjudicate([candidate('a')]);
    expect(transport.requests).toHaveLength(0);
    expect(outcome?.kind).toBe('failure');
    if (outcome?.kind === 'failure') expect(outcome.failure.kind).toBe('disabled');
  });

  it('records prompt version, model id and content hash in the trace', async () => {
    const traces: unknown[] = [];
    const transport = new ScriptedTransport([], { content: VERDICT });
    const broker = new SemanticBroker(config({ trace: true, model: 'm1' }), {
      transport,
      trace: (t) => traces.push(t),
    });
    const [outcome] = await broker.adjudicate([candidate('a')]);
    expect(outcome?.trace.promptVersion).toBe('v1');
    expect(outcome?.trace.modelId).toBe('m1');
    expect(outcome?.trace.contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(traces).toHaveLength(1);
  });

  it('reports a prompt-construction failure instead of contacting the service', async () => {
    const transport = new ScriptedTransport([], { content: VERDICT });
    const broker = new SemanticBroker(config(), { transport });
    const [outcome] = await broker.adjudicate([
      candidate('a', { payload: {} }), // missing required `candidateVerbs`
    ]);
    expect(transport.requests).toHaveLength(0);
    expect(outcome?.kind).toBe('failure');
  });

  it('constrains the response with a JSON schema', async () => {
    const transport = new ScriptedTransport([], { content: VERDICT });
    const broker = new SemanticBroker(config(), { transport });
    await broker.adjudicate([candidate('a')]);
    expect(transport.requests[0]?.jsonSchema).toBeDefined();
    expect(transport.requests[0]?.temperature).toBe(0);
  });
});
