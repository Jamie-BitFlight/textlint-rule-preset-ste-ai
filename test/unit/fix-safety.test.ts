import { describe, expect, it } from 'vitest';
import { autofixPolicySchema, resolveConfig } from '../../src/core/config.js';
import { analyseDocument } from '../../src/core/document.js';
import { checkFixSafety, gateFix } from '../../src/core/rule.js';
import { resolveOverlappingFixes, runDeterministicRules } from '../../src/core/runner.js';
import type { Diagnostic } from '../../src/core/types.js';
import { deterministicRules } from '../../src/deterministic/index.js';
import { provisionalRulePack } from '../../src/rule-pack/provisional-pack.js';

const policy = resolveConfig({}).diagnostics;

describe('checkFixSafety', () => {
  const allowed: readonly [string, string, string][] = [
    ['expands a negative contraction', "don't", 'do not'],
    ['expands cannot', "can't", 'cannot'],
    ['swaps a formal synonym', 'utilise', 'use'],
    ['normalises a register variant of an ordering word', 'prior to', 'before'],
    ['normalises whilst', 'whilst', 'while'],
    ['normalises amongst', 'amongst', 'among'],
    ['fixes a spelling', 'web site', 'website'],
    ['drops a filler phrase', 'in order to', 'to'],
  ];
  for (const [label, before, after] of allowed) {
    it(`allows: ${label}`, () => {
      expect(checkFixSafety(before, after)).toBeNull();
    });
  }

  const refused: readonly [string, string, string, RegExp][] = [
    ['changes a quantity', 'torque to 25 Nm', 'torque to 20 Nm', /numeric value/],
    ['drops a tolerance digit', '25 ± 2', '25 ± 3', /numeric value/],
    ['removes a negation', 'do not remove the cover', 'remove the cover', /negation/],
    ['adds a negation', 'remove the cover', 'do not remove the cover', /negation/],
    [
      'weakens a modal',
      'the technician must isolate',
      'the technician should isolate',
      /modal force/,
    ],
    ['strengthens a modal', 'you may reset it', 'you must reset it', /modal force/],
    ['drops a modal', 'you must reset it', 'you reset it', /modal force/],
    [
      'reverses an ordering word',
      'before you fit the cover',
      'after you fit the cover',
      /ordering word/,
    ],
    ['drops an ordering word', 'first stop the pump', 'stop the pump', /ordering word/],
    ['collapses a double negation', 'do not not touch', 'do not touch', /negation/],
  ];
  for (const [label, before, after, pattern] of refused) {
    it(`refuses: ${label}`, () => {
      expect(checkFixSafety(before, after)?.reason).toMatch(pattern);
    });
  }
});

describe('gateFix', () => {
  const doc = analyseDocument({
    id: 't',
    format: 'markdown',
    text: 'Utilise the tool.\n\n> [!WARNING]\n> Utilise the busbar.\n\nRun `utilise --now`.\n',
  });
  const autofix = autofixPolicySchema.parse({});

  it('allows a safe fix in ordinary prose', () => {
    const at = doc.text.indexOf('Utilise');
    expect(
      gateFix({
        doc,
        fix: {
          range: { start: at, end: at + 7 },
          text: 'Use',
          rationale: 'r',
          safety: 'deterministic-meaning-preserving',
        },
        admonition: 'none',
        ruleFixable: true,
        autofix,
      }),
    ).toBeNull();
  });

  for (const admonition of ['warning', 'caution', 'danger', 'note'] as const) {
    it(`refuses any fix inside a ${admonition} admonition`, () => {
      const at = doc.text.lastIndexOf('Utilise');
      expect(
        gateFix({
          doc,
          fix: {
            range: { start: at, end: at + 7 },
            text: 'Use',
            rationale: 'r',
            safety: 'deterministic-meaning-preserving',
          },
          admonition,
          ruleFixable: true,
          autofix,
        })?.reason,
      ).toContain(`${admonition} admonition`);
    });
  }

  it('refuses a fix that overlaps a protected region', () => {
    const at = doc.text.indexOf('utilise --now');
    expect(
      gateFix({
        doc,
        fix: {
          range: { start: at, end: at + 7 },
          text: 'use',
          rationale: 'r',
          safety: 'deterministic-meaning-preserving',
        },
        admonition: 'none',
        ruleFixable: true,
        autofix,
      })?.reason,
    ).toContain('protected region');
  });

  it('refuses when autofix is disabled', () => {
    expect(
      gateFix({
        doc,
        fix: {
          range: { start: 0, end: 7 },
          text: 'Use',
          rationale: 'r',
          safety: 'deterministic-meaning-preserving',
        },
        admonition: 'none',
        ruleFixable: true,
        autofix: autofixPolicySchema.parse({ enabled: false }),
      })?.reason,
    ).toContain('disabled by configuration');
  });

  it('refuses a semantic-gated fix unless explicitly allowed', () => {
    const fix = {
      range: { start: 0, end: 7 },
      text: 'Use',
      rationale: 'r',
      safety: 'semantic-gated' as const,
    };
    expect(gateFix({ doc, fix, admonition: 'none', ruleFixable: true, autofix })?.reason).toContain(
      'semantic-gated fixes are disabled',
    );
    expect(
      gateFix({
        doc,
        fix,
        admonition: 'none',
        ruleFixable: true,
        autofix: autofixPolicySchema.parse({ allowSemanticFixes: true }),
      }),
    ).toBeNull();
  });

  it('refuses when the rule does not declare itself fixable', () => {
    expect(
      gateFix({
        doc,
        fix: {
          range: { start: 0, end: 7 },
          text: 'Use',
          rationale: 'r',
          safety: 'deterministic-meaning-preserving',
        },
        admonition: 'none',
        ruleFixable: false,
        autofix,
      })?.reason,
    ).toContain('does not declare a fix');
  });

  it('allowInAdmonitions cannot be set to true', () => {
    expect(autofixPolicySchema.safeParse({ allowInAdmonitions: true }).success).toBe(false);
  });
});

describe('overlapping fixes', () => {
  const fix = (start: number, end: number, text: string): Diagnostic => ({
    ruleId: `r${start}`,
    ruleStatus: 'provisional',
    category: 'deterministic-violation',
    severity: 'error',
    message: 'm',
    range: { start, end },
    producedBy: 'deterministic',
    fix: {
      range: { start, end },
      text,
      rationale: 'r',
      safety: 'deterministic-meaning-preserving',
    },
  });

  it('keeps non-overlapping fixes', () => {
    const result = resolveOverlappingFixes([fix(0, 5, 'a'), fix(10, 15, 'b')], policy);
    expect(result.diagnostics.filter((d) => d.fix !== undefined)).toHaveLength(2);
    expect(result.notices).toEqual([]);
  });

  it('refuses both fixes when two rules disagree about the same characters', () => {
    const result = resolveOverlappingFixes([fix(0, 5, 'a'), fix(3, 8, 'b')], policy);
    expect(result.diagnostics.filter((d) => d.fix !== undefined)).toHaveLength(0);
    expect(result.diagnostics.every((d) => d.message.includes('overlapping edit'))).toBe(true);
    expect(result.notices[0]?.code).toBe('overlapping-fixes-refused');
  });

  it('treats an identical fix from two rules as a duplicate, not a conflict', () => {
    const result = resolveOverlappingFixes([fix(0, 5, 'same'), fix(0, 5, 'same')], policy);
    expect(result.diagnostics.filter((d) => d.fix !== undefined)).toHaveLength(1);
  });

  it('resolution is deterministic across runs', () => {
    const input = [fix(0, 5, 'a'), fix(3, 8, 'b'), fix(20, 25, 'c')];
    const a = resolveOverlappingFixes(input, policy).diagnostics.map((d) => d.fix?.text ?? null);
    const b = resolveOverlappingFixes(input, policy).diagnostics.map((d) => d.fix?.text ?? null);
    expect(a).toEqual(b);
    expect(a).toEqual([null, null, 'c']);
  });
});

describe('end-to-end fix behaviour', () => {
  function fixesFor(text: string): { quote: string; replacement: string }[] {
    const doc = analyseDocument({ id: 't', format: 'markdown', text });
    const result = runDeterministicRules({
      doc,
      rules: deterministicRules,
      config: resolveConfig({}),
      pack: provisionalRulePack,
    });
    return result.diagnostics
      .filter((d) => d.fix !== undefined)
      .map((d) => ({
        quote: text.slice(d.fix?.range.start, d.fix?.range.end),
        replacement: d.fix?.text ?? '',
      }));
  }

  it('offers no fix at all for a document of warnings', () => {
    const text = "> [!DANGER]\n> Don't utilise the busbar prior to isolation.\n";
    expect(fixesFor(text)).toEqual([]);
  });

  it('offers fixes in ordinary prose for the same wording', () => {
    const text = "Don't utilise the bracket prior to isolation.\n";
    const fixes = fixesFor(text);
    expect(fixes).toEqual(
      expect.arrayContaining([
        { quote: "Don't", replacement: 'Do not' },
        { quote: 'utilise', replacement: 'use' },
        { quote: 'prior to', replacement: 'before' },
      ]),
    );
  });

  it('never proposes a fix that touches a quantity', () => {
    const text = 'Torque to 25Nm and utilise the wrench.\n';
    for (const fix of fixesFor(text)) {
      expect(fix.quote).not.toMatch(/\d/);
    }
  });
});
