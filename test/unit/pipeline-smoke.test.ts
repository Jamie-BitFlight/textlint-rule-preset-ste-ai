import { describe, expect, it } from 'vitest';
import { analyseDocument } from '../../src/core/document.js';
import { resolveConfig } from '../../src/core/config.js';
import { runDeterministicRules } from '../../src/core/runner.js';
import { deterministicRules } from '../../src/deterministic/index.js';
import { provisionalRulePack } from '../../src/rule-pack/provisional-pack.js';

const SAMPLE = `---
title: Test
---

# Install the sensor

Prior to installation, don't utilise the the old bracket.

> [!WARNING]
> Do not touch the busbar. It is live at 400 V.

1. Set the switch to \`OFF\` and remove the cover.
2. Torque the bolt to 12 Nm.

\`\`\`bash
utilise --whilst don't
\`\`\`

See <https://example.com/docs> and /etc/hosts for details.
`;

function analyse(text: string) {
  const doc = analyseDocument({ id: 'sample', format: 'markdown', text });
  const config = resolveConfig({});
  return {
    doc,
    result: runDeterministicRules({
      doc,
      rules: deterministicRules,
      config,
      pack: provisionalRulePack,
    }),
  };
}

describe('analysis pipeline', () => {
  it('reports diagnostics whose ranges point at the reported text', () => {
    const { doc, result } = analyse(SAMPLE);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    for (const d of result.diagnostics) {
      expect(d.range.end).toBeGreaterThan(d.range.start);
      expect(d.range.end).toBeLessThanOrEqual(doc.text.length);
    }
  });

  it('never reports inside a fenced code block', () => {
    const { doc, result } = analyse(SAMPLE);
    const fenceStart = doc.text.indexOf('```bash');
    const fenceEnd = doc.text.indexOf('```', fenceStart + 3) + 3;
    expect(fenceStart).toBeGreaterThan(0);
    const inside = result.diagnostics.filter(
      (d) => d.range.start >= fenceStart && d.range.end <= fenceEnd,
    );
    expect(inside).toEqual([]);
  });

  it('finds the contraction, the unapproved phrase and the repeated word in prose', () => {
    const { doc, result } = analyse(SAMPLE);
    const quoted = result.diagnostics.map((d) => ({
      ruleId: d.ruleId,
      text: doc.text.slice(d.range.start, d.range.end),
    }));
    expect(quoted).toEqual(
      expect.arrayContaining([
        { ruleId: 'unapproved-vocabulary', text: 'Prior to' },
        { ruleId: 'no-contractions', text: "don't" },
        { ruleId: 'unapproved-vocabulary', text: 'utilise' },
        { ruleId: 'no-repeated-words', text: 'the the' },
      ]),
    );
  });

  it('classifies the numbered steps as procedural and the warning as a warning admonition', () => {
    const { doc } = analyse(SAMPLE);
    const step = doc.sentences.find((s) => s.raw.includes('Set the switch'));
    expect(step?.mode).toBe('procedural');
    const hazard = doc.sentences.find((s) => s.raw.includes('busbar'));
    expect(hazard?.admonition).toBe('warning');
  });

  it('refuses to autofix inside a warning admonition', () => {
    const text = "> [!WARNING]\n> Don't touch the busbar.\n";
    const { result } = analyse(text);
    const contraction = result.diagnostics.filter((d) => d.ruleId === 'no-contractions');
    expect(contraction.length).toBe(1);
    expect(contraction[0]?.fix).toBeUndefined();
    expect(contraction[0]?.message).toContain('warning admonition');
  });

  it('does autofix the same contraction outside an admonition', () => {
    const { result } = analyse("Don't touch the bracket.\n");
    const contraction = result.diagnostics.find((d) => d.ruleId === 'no-contractions');
    expect(contraction?.fix?.text).toBe('Do not');
  });
});
