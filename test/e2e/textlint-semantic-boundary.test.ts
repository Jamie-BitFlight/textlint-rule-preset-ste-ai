import { TextlintKernel, type TextlintPluginCreator } from '@textlint/kernel';
import markdownPluginModule from '@textlint/textlint-plugin-markdown';
import type { TextlintRuleModule } from '@textlint/types';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { clearAnalysisCache } from '../../src/textlint/adapter.js';
import { rules } from '../../src/textlint/preset.js';
import {
  startFakeSemanticService,
  verdictJson,
  type FakeService,
} from '../helpers/fake-semantic-service.js';

/**
 * Boundary coverage for the semantic → `TextlintMessage` path.
 *
 * `src/textlint/adapter.ts` (`getAnalysis`, `formatMessage`, `toTextlintSeverity`, the `Document`
 * handler's report loop) is what turns an internal `Diagnostic` into the `TextlintMessage` a real
 * textlint consumer receives. These tests prove a *semantic* verdict specifically — as opposed to a
 * deterministic one — survives that adapter, by running the real kernel, the real markdown plugin
 * and the real preset rule module against a real HTTP fake of the semantic service
 * (`startFakeSemanticService`), and asserting on `result.messages` — never on `Diagnostic`.
 */

function isTextlintPluginCreator(value: unknown): value is TextlintPluginCreator {
  return (
    typeof value === 'object' &&
    value !== null &&
    'Processor' in value &&
    typeof value.Processor === 'function'
  );
}

function asTextlintPluginCreator(value: unknown, packageName: string): TextlintPluginCreator {
  if (!isTextlintPluginCreator(value)) {
    throw new Error(`${packageName}'s default export is not TextlintPluginCreator-shaped.`);
  }
  return value;
}

const markdownPlugin = asTextlintPluginCreator(
  markdownPluginModule,
  '@textlint/textlint-plugin-markdown',
);

const kernel = new TextlintKernel();

function mustGetRule(id: string): TextlintRuleModule {
  const rule = rules[id];
  if (rule === undefined) {
    throw new Error(`preset does not define a rule named "${id}"`);
  }
  return rule;
}

/**
 * A passage `one-instruction-per-sentence` (`src/deterministic/rules/structure-rules.ts`) flags as
 * a comma-joined clause with a second candidate imperative verb — a real candidate for semantic
 * adjudication, confirmed directly (`analyseTextDeterministic` on this text, semantic disabled,
 * reports a `review-required` diagnostic for `one-instruction-per-sentence` spanning the whole
 * sentence). Never asserted as a compliance failure on its own; the semantic verdict decides it.
 */
const TWO_ACTIONS = 'Remove the cover, install the new filter.\n';

function lintOptions(endpoint: string, overrides: Record<string, unknown> = {}) {
  return {
    ext: '.md',
    plugins: [{ pluginId: 'markdown', plugin: markdownPlugin }],
    rules: [
      {
        ruleId: 'one-instruction-per-sentence',
        rule: mustGetRule('one-instruction-per-sentence'),
        options: {
          shared: {
            semantic: {
              enabled: true,
              endpoint,
              model: 'fake-model',
              maxTransportRetries: 0,
              maxRepairAttempts: 0,
              cache: false,
            },
            ...overrides,
          },
        },
      },
    ],
  };
}

let service: FakeService | undefined;

beforeEach(() => {
  clearAnalysisCache();
});

afterEach(async () => {
  await service?.close();
  service = undefined;
});

describe('semantic verdicts crossing the textlint adapter boundary', () => {
  it('a violation verdict reaches the emitted TextlintMessage with message, range and severity', async () => {
    service = await startFakeSemanticService({
      handler: (body) => {
        const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
        const ruleId = /ruleId:\s*(\S+)/.exec(user)?.[1] ?? 'unknown';
        return {
          content: verdictJson({
            ruleId,
            status: 'violation',
            confidence: 0.93,
            // Evidence span into the passage ("Remove"), distinct from the candidate's own
            // whole-sentence range -- proves the *evidence* offset is what reaches textlint, not
            // just the candidate's start.
            evidenceStart: 0,
            evidenceEnd: 6,
            explanation: 'DISTINCTIVE_SEMANTIC_VIOLATION_MARKER',
            suggestedReplacements: [],
            meaningPreserved: false,
          }),
        };
      },
    });

    const result = await kernel.lintText(TWO_ACTIONS, lintOptions(service.url));

    expect(result.messages).toHaveLength(1);
    const message = result.messages[0];
    expect(message?.ruleId).toBe('one-instruction-per-sentence');
    expect(message?.message).toContain('DISTINCTIVE_SEMANTIC_VIOLATION_MARKER');
    // Default `probable-semantic-violation` severity is `warning`, textlint level 1 -- distinct
    // from the `error` (2) a deterministic violation defaults to, and from `info` (3).
    expect(message?.severity).toBe(1);
    // The evidence span "Remove" (offset 0-6) on line 1.
    expect(message?.loc.start.line).toBe(1);
    expect(message?.loc.start.column).toBe(1);
    expect(message?.loc.end.column).toBe(7);
    expect(message?.range).toEqual([0, 6]);
  });

  it('a compliant verdict emits no TextlintMessage for that passage', async () => {
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
            explanation: 'DISTINCTIVE_COMPLIANT_MARKER',
            suggestedReplacements: [],
          }),
        };
      },
    });

    const result = await kernel.lintText(TWO_ACTIONS, lintOptions(service.url));

    expect(result.messages).toEqual([]);
  });

  it('a per-rule severity override on a semantic verdict reaches the TextlintMessage', async () => {
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
            explanation: 'DISTINCTIVE_SEMANTIC_VIOLATION_MARKER',
            suggestedReplacements: [],
            meaningPreserved: false,
          }),
        };
      },
    });

    const result = await kernel.lintText(
      TWO_ACTIONS,
      lintOptions(service.url, {
        diagnostics: { severity: { 'probable-semantic-violation': 'error' } },
      }),
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.severity).toBe(2);
  });
});
