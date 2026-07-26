import { afterEach, describe, expect, it } from 'vitest';
import { analyseText, analyseTextDeterministic } from '../../src/analysis/analyse.js';
import { LlamaCppClient } from '../../src/model-client/llama-client.js';
import {
  startFakeSemanticService,
  verdictJson,
  type FakeService,
} from '../helpers/fake-semantic-service.js';

/**
 * Integration tests against a real HTTP server that speaks the llama.cpp OpenAI-compatible route.
 *
 * A transport double cannot prove the client sends a body a real server accepts, nor that it parses
 * a real response. These tests do that, and they exercise the outage policy end to end.
 */

const AMBIGUOUS = 'Connect the sensor to the controller. It must be earthed.\n';
const TWO_ACTIONS = 'Remove the cover, install the new filter.\n';

let service: FakeService | undefined;

afterEach(async () => {
  await service?.close();
  service = undefined;
});

function semanticConfig(endpoint: string, overrides: Record<string, unknown> = {}) {
  return {
    semantic: {
      enabled: true,
      endpoint,
      model: 'fake-model',
      maxTransportRetries: 0,
      maxRepairAttempts: 0,
      cache: false,
      ...overrides,
    },
  };
}

describe('llama.cpp client against a real server', () => {
  it('sends an OpenAI-shaped body and parses the reply', async () => {
    let seen: unknown;
    service = await startFakeSemanticService({
      handler: (body) => {
        seen = body;
        return {
          content: verdictJson({
            ruleId: 'r',
            status: 'compliant',
            confidence: 0.9,
            suggestedReplacements: [],
          }),
        };
      },
    });
    const client = new LlamaCppClient({ endpoint: service.url, requestTimeoutMs: 5000 });
    const response = await client.complete({
      messages: [{ role: 'user', content: 'hello' }],
      model: 'fake-model',
      temperature: 0,
      maxTokens: 128,
      jsonSchema: { type: 'object' },
    });
    expect(response.modelId).toBe('fake-model');
    expect(response.text).toContain('"status"');
    const body = seen as { model: string; messages: unknown[]; response_format?: { type: string } };
    expect(body.model).toBe('fake-model');
    expect(body.messages).toHaveLength(1);
    expect(body.response_format?.type).toBe('json_schema');
  });

  it('classifies a 500 as retryable and a 400 as not', async () => {
    service = await startFakeSemanticService({ handler: () => ({ status: 500 }) });
    const client = new LlamaCppClient({ endpoint: service.url, requestTimeoutMs: 5000 });
    await expect(
      client.complete({ messages: [], model: 'm', temperature: 0, maxTokens: 8 }),
    ).rejects.toMatchObject({ kind: 'http', retryable: true, status: 500 });

    await service.close();
    service = await startFakeSemanticService({ handler: () => ({ status: 400 }) });
    const client2 = new LlamaCppClient({ endpoint: service.url, requestTimeoutMs: 5000 });
    await expect(
      client2.complete({ messages: [], model: 'm', temperature: 0, maxTokens: 8 }),
    ).rejects.toMatchObject({ kind: 'http', retryable: false, status: 400 });
  });

  it('times out and reports a timeout rather than hanging', async () => {
    service = await startFakeSemanticService({ handler: () => ({ content: '{}', delayMs: 1500 }) });
    const client = new LlamaCppClient({ endpoint: service.url, requestTimeoutMs: 150 });
    await expect(
      client.complete({ messages: [], model: 'm', temperature: 0, maxTokens: 8 }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('reports cancellation distinctly from a timeout', async () => {
    service = await startFakeSemanticService({ handler: () => ({ content: '{}', delayMs: 1000 }) });
    const client = new LlamaCppClient({ endpoint: service.url, requestTimeoutMs: 5000 });
    const controller = new AbortController();
    const promise = client.complete({
      messages: [],
      model: 'm',
      temperature: 0,
      maxTokens: 8,
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ kind: 'cancelled', retryable: false });
  });

  it('rejects a 200 response with no message content', async () => {
    service = await startFakeSemanticService({ handler: () => ({ body: { choices: [] } }) });
    const client = new LlamaCppClient({ endpoint: service.url, requestTimeoutMs: 5000 });
    await expect(
      client.complete({ messages: [], model: 'm', temperature: 0, maxTokens: 8 }),
    ).rejects.toMatchObject({ kind: 'malformed', retryable: false });
  });

  it('reports a network failure when nothing is listening', async () => {
    const client = new LlamaCppClient({ endpoint: 'http://127.0.0.1:1', requestTimeoutMs: 2000 });
    await expect(
      client.complete({ messages: [], model: 'm', temperature: 0, maxTokens: 8 }),
    ).rejects.toMatchObject({ kind: 'network', retryable: true });
  });
});

describe('end-to-end semantic analysis via HTTP', () => {
  it('turns a violation verdict into a probable-semantic-violation diagnostic', async () => {
    service = await startFakeSemanticService({
      handler: (body) => {
        const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
        const ruleId = /ruleId:\s*(\S+)/.exec(user)?.[1] ?? 'unknown';
        return {
          content: verdictJson({
            ruleId,
            status: 'violation',
            confidence: 0.93,
            evidenceStart: 0,
            evidenceEnd: 6,
            explanation: 'Two actions in one instruction.',
            suggestedReplacements: [],
            meaningPreserved: false,
          }),
        };
      },
    });
    const result = await analyseText(TWO_ACTIONS, { config: semanticConfig(service.url) });
    const semantic = result.diagnostics.filter((d) => d.producedBy === 'semantic');
    expect(semantic.length).toBeGreaterThan(0);
    const probable = semantic.find((d) => d.category === 'probable-semantic-violation');
    expect(probable).toBeDefined();
    expect(probable?.modelReportedConfidence).toBe(0.93);
    expect(probable?.decisionThreshold).toBe(0.7);
    expect(probable?.message).toContain('Two actions in one instruction.');
  });

  it('drops a compliant verdict without emitting a diagnostic', async () => {
    service = await startFakeSemanticService({
      handler: (body) => {
        const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
        const ruleId = /ruleId:\s*(\S+)/.exec(user)?.[1] ?? 'unknown';
        return {
          content: verdictJson({
            ruleId,
            status: 'compliant',
            confidence: 0.95,
            evidenceStart: 0,
            evidenceEnd: 0,
            explanation: 'One action only.',
            suggestedReplacements: [],
          }),
        };
      },
    });
    const result = await analyseText(TWO_ACTIONS, { config: semanticConfig(service.url) });
    expect(result.diagnostics.filter((d) => d.producedBy === 'semantic')).toEqual([]);
  });

  it('suppresses a violation below the configured threshold and reports it when asked', async () => {
    const handler = (body: { messages?: { role: string; content: string }[] }) => {
      const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
      const ruleId = /ruleId:\s*(\S+)/.exec(user)?.[1] ?? 'unknown';
      return {
        content: verdictJson({
          ruleId,
          status: 'violation',
          confidence: 0.4,
          evidenceStart: 0,
          evidenceEnd: 6,
          explanation: 'Weak signal.',
          suggestedReplacements: [],
          meaningPreserved: false,
        }),
      };
    };
    service = await startFakeSemanticService({ handler });

    const quiet = await analyseText(TWO_ACTIONS, { config: semanticConfig(service.url) });
    expect(quiet.diagnostics.filter((d) => d.category === 'suppressed-low-confidence')).toEqual([]);
    expect(quiet.diagnostics.filter((d) => d.category === 'probable-semantic-violation')).toEqual(
      [],
    );

    const loud = await analyseText(TWO_ACTIONS, {
      config: { ...semanticConfig(service.url), diagnostics: { reportSuppressed: true } },
    });
    const suppressed = loud.diagnostics.filter((d) => d.category === 'suppressed-low-confidence');
    expect(suppressed.length).toBeGreaterThan(0);
    expect(suppressed[0]?.modelReportedConfidence).toBe(0.4);
  });

  it('turns an uncertain verdict into review-required', async () => {
    service = await startFakeSemanticService({
      handler: (body) => {
        const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
        const ruleId = /ruleId:\s*(\S+)/.exec(user)?.[1] ?? 'unknown';
        return {
          content: verdictJson({
            ruleId,
            status: 'uncertain',
            confidence: 0.5,
            evidenceStart: 0,
            evidenceEnd: 2,
            explanation: 'Cannot tell.',
            suggestedReplacements: [],
          }),
        };
      },
    });
    const result = await analyseText(AMBIGUOUS, { config: semanticConfig(service.url) });
    const review = result.diagnostics.filter((d) => d.category === 'review-required');
    expect(review.length).toBeGreaterThan(0);
    expect(review[0]?.message).toContain('uncertain');
  });

  it('anchors the diagnostic at the model evidence span when it is inside the passage', async () => {
    service = await startFakeSemanticService({
      handler: (body) => {
        const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
        const ruleId = /ruleId:\s*(\S+)/.exec(user)?.[1] ?? 'unknown';
        return {
          content: verdictJson({
            ruleId,
            status: 'violation',
            confidence: 0.95,
            evidenceStart: 18,
            evidenceEnd: 25,
            explanation: 'Second action here.',
            suggestedReplacements: [],
            meaningPreserved: false,
          }),
        };
      },
    });
    const result = await analyseText(TWO_ACTIONS, { config: semanticConfig(service.url) });
    const probable = result.diagnostics.find((d) => d.category === 'probable-semantic-violation');
    expect(probable).toBeDefined();
    expect(TWO_ACTIONS.slice(probable?.range.start, probable?.range.end)).toBe('install');
  });

  it('falls back to the candidate span when the evidence span is out of range', async () => {
    service = await startFakeSemanticService({
      handler: (body) => {
        const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
        const ruleId = /ruleId:\s*(\S+)/.exec(user)?.[1] ?? 'unknown';
        return {
          content: verdictJson({
            ruleId,
            status: 'violation',
            confidence: 0.95,
            evidenceStart: 0,
            evidenceEnd: 0,
            explanation: 'No usable span.',
            suggestedReplacements: [],
            meaningPreserved: false,
          }),
        };
      },
    });
    const result = await analyseText(TWO_ACTIONS, { config: semanticConfig(service.url) });
    const probable = result.diagnostics.find((d) => d.category === 'probable-semantic-violation');
    expect(TWO_ACTIONS.slice(probable?.range.start, probable?.range.end)).toContain(
      'Remove the cover',
    );
  });
});

describe('service-outage policy', () => {
  it('notice policy: emits a run notice, reports review-required, and claims no compliance', async () => {
    service = await startFakeSemanticService({ handler: () => ({ status: 503 }) });
    const result = await analyseText(TWO_ACTIONS, { config: semanticConfig(service.url) });
    const notice = result.notices.find((n) => n.code === 'semantic-service-failure');
    expect(notice).toBeDefined();
    expect(notice?.level).toBe('warning');
    expect(notice?.message).toContain('No compliance conclusion was drawn');
    expect(result.diagnostics.some((d) => d.category === 'review-required')).toBe(true);
  });

  it('error policy: raises the notice to error level', async () => {
    service = await startFakeSemanticService({ handler: () => ({ status: 503 }) });
    const result = await analyseText(TWO_ACTIONS, {
      config: {
        ...semanticConfig(service.url),
        diagnostics: { onSemanticServiceFailure: 'error' },
      },
    });
    expect(result.notices.find((n) => n.code === 'semantic-service-failure')?.level).toBe('error');
  });

  it('silent policy: still records the notice but emits no per-candidate diagnostic', async () => {
    service = await startFakeSemanticService({ handler: () => ({ status: 503 }) });
    const result = await analyseText(TWO_ACTIONS, {
      config: {
        ...semanticConfig(service.url),
        diagnostics: { onSemanticServiceFailure: 'silent' },
      },
    });
    expect(result.notices.some((n) => n.code === 'semantic-service-failure')).toBe(true);
    expect(result.diagnostics.filter((d) => d.producedBy === 'semantic')).toEqual([]);
  });

  it('an outage never removes a deterministic violation', async () => {
    service = await startFakeSemanticService({ handler: () => ({ status: 503 }) });
    const text = "Utilise the bracket. Don't touch the busbar.\n";
    const withOutage = await analyseText(text, { config: semanticConfig(service.url) });
    const offline = analyseTextDeterministic(text);
    const deterministicIds = (ds: readonly { ruleId: string; producedBy: string }[]) =>
      ds
        .filter((d) => d.producedBy === 'deterministic')
        .map((d) => d.ruleId)
        .sort();
    expect(deterministicIds(withOutage.diagnostics)).toEqual(deterministicIds(offline.diagnostics));
  });

  it('a malformed reply is reported as a failure, not as compliance', async () => {
    service = await startFakeSemanticService({
      handler: () => ({ content: 'I think it is fine.' }),
    });
    const result = await analyseText(TWO_ACTIONS, { config: semanticConfig(service.url) });
    expect(result.notices.some((n) => n.code === 'semantic-service-failure')).toBe(true);
    expect(result.diagnostics.some((d) => d.category === 'review-required')).toBe(true);
  });
});

describe('deterministic-only mode', () => {
  it('performs no HTTP at all when semantic analysis is disabled', async () => {
    let contacted = false;
    service = await startFakeSemanticService({
      handler: () => {
        contacted = true;
        return { content: '{}' };
      },
    });
    const result = await analyseText(TWO_ACTIONS, {
      config: { semantic: { enabled: false, endpoint: service.url } },
    });
    expect(contacted).toBe(false);
    expect(service.requestCount()).toBe(0);
    expect(result.diagnostics.some((d) => d.category === 'review-required')).toBe(true);
    expect(result.notices.some((n) => n.code === 'semantic-disabled')).toBe(true);
  });

  it('still finds every deterministic violation offline', () => {
    const result = analyseTextDeterministic("Prior to the test, don't utilise the the bracket.\n");
    const ids = new Set(result.diagnostics.map((d) => d.ruleId));
    expect(ids).toContain('unapproved-vocabulary');
    expect(ids).toContain('no-contractions');
    expect(ids).toContain('no-repeated-words');
  });
});

describe('semantic autofix gate', () => {
  const REWRITE_OK = 'compliant';

  it('refuses a semantic fix by default', async () => {
    service = await startFakeSemanticService({
      handler: (body) => {
        const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
        const ruleId = /ruleId:\s*(\S+)/.exec(user)?.[1] ?? 'unknown';
        return {
          content: verdictJson({
            ruleId,
            status: 'violation',
            confidence: 0.95,
            evidenceStart: 0,
            evidenceEnd: 6,
            explanation: 'Two actions.',
            suggestedReplacements: ['Remove the cover.'],
            meaningPreserved: true,
          }),
        };
      },
    });
    const result = await analyseText(TWO_ACTIONS, { config: semanticConfig(service.url) });
    const semantic = result.diagnostics.filter((d) => d.producedBy === 'semantic');
    expect(semantic.every((d) => d.fix === undefined)).toBe(true);
  });

  it('requires an independent equivalence pass before attaching a semantic fix', async () => {
    const seenRules: string[] = [];
    service = await startFakeSemanticService({
      handler: (body) => {
        const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
        const ruleId = /ruleId:\s*(\S+)/.exec(user)?.[1] ?? 'unknown';
        const isGate = user.includes('REWRITTEN');
        seenRules.push(isGate ? 'gate' : 'primary');
        return {
          content: verdictJson({
            ruleId,
            status: isGate ? REWRITE_OK : 'violation',
            confidence: 0.95,
            evidenceStart: 0,
            evidenceEnd: isGate ? 0 : 6,
            explanation: isGate ? 'no difference found' : 'Two actions.',
            suggestedReplacements: isGate ? [] : ['Remove the cover'],
            meaningPreserved: true,
          }),
        };
      },
    });
    const result = await analyseText(TWO_ACTIONS, {
      config: {
        ...semanticConfig(service.url),
        autofix: { allowSemanticFixes: true },
      },
    });
    expect(seenRules).toContain('gate');
    const fixed = result.diagnostics.find(
      (d) => d.producedBy === 'semantic' && d.fix !== undefined,
    );
    expect(fixed?.fix?.safety).toBe('semantic-gated');
    expect(fixed?.fix?.rationale).toContain('rewrite-equivalence');
  });

  it('withholds the fix when the equivalence gate reports a meaning change', async () => {
    service = await startFakeSemanticService({
      handler: (body) => {
        const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
        const ruleId = /ruleId:\s*(\S+)/.exec(user)?.[1] ?? 'unknown';
        const isGate = user.includes('REWRITTEN');
        return {
          content: verdictJson({
            ruleId,
            status: 'violation',
            confidence: 0.95,
            evidenceStart: 0,
            evidenceEnd: isGate ? 3 : 6,
            explanation: isGate ? 'a precondition was dropped' : 'Two actions.',
            suggestedReplacements: isGate ? [] : ['Remove the cover'],
            meaningPreserved: false,
          }),
        };
      },
    });
    const result = await analyseText(TWO_ACTIONS, {
      config: { ...semanticConfig(service.url), autofix: { allowSemanticFixes: true } },
    });
    expect(
      result.diagnostics.every((d) => d.fix === undefined || d.fix.safety !== 'semantic-gated'),
    ).toBe(true);
  });
});
