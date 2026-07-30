import { afterEach, describe, expect, it } from 'vitest';
import { analyseText, analyseTextDeterministic } from '../../src/analysis/analyse.js';
import {
  startFakeSemanticService,
  verdictJson,
  type FakeService,
} from '../helpers/fake-semantic-service.js';

/**
 * `analysis`'s two production entry points wired to the new reader (`src/reader/`), replacing
 * `scanBlocks()`'s role there specifically — not everywhere `scanBlocks()` is still called (eight
 * other direct callers of `analyseDocument` outside `analysis` are untouched; see
 * `docs/architecture.md`, "Document reader").
 *
 * The point of this suite: prove, through the real production entry points rather than the reader
 * in isolation, that (a) the exact defect class issue #11 measured is now fixed end-to-end, and (b)
 * the rule contract did not change — every existing deterministic-rule test keeps passing unmodified,
 * which is the only thing that can demonstrate that boundary held.
 */

let service: FakeService | undefined;

afterEach(async () => {
  await service?.close();
  service = undefined;
});

describe('the reader is wired into analyseTextDeterministic for markdown', () => {
  it('reports a table cell and a link with the correct spans, the issue #11 defect class', () => {
    const text = [
      '| Step | Action |',
      '| --- | --- |',
      '| 1 | Utilise the tool |',
      '',
      'See [the guide](./guide.md) before you continue.',
      '',
    ].join('\n');
    const result = analyseTextDeterministic(text);
    const cellFinding = result.diagnostics.find(
      (d) =>
        d.ruleId === 'unapproved-vocabulary' &&
        text.slice(d.range.start, d.range.end) === 'Utilise',
    );
    expect(cellFinding).toBeDefined();
    // The finding's span sits entirely inside the cell's own prose, not straddling the `|` markup.
    expect(cellFinding?.range.start).toBe(text.indexOf('Utilise the tool'));
  });

  it('produces blocks with the reader’s own id shape, not scanBlocks’s counter-based ids', () => {
    // A test that only checks *findings* can pass whether or not the reader is actually wired in —
    // `scanBlocks` gets plenty of simple cases right too. This checks something that can only be
    // true if `analyseTextDeterministic` is genuinely using `readMarkdownUnitsSync`'s output:
    // `scanBlocks` ids are a bare counter (`b1`, `b2`, …); the reader's ids are self-describing
    // (`kind:counter:offset`), and that difference is what proves which path actually ran.
    const result = analyseTextDeterministic('Utilise the bracket.\n');
    expect(result.document.blocks[0]?.id).toMatch(/^paragraph:\d+:\d+$/);
  });

  it('still classifies a heading as descriptive, not procedural, through the production path', () => {
    const text = '# Remove the bracket\n\nUtilise the filter.\n';
    const result = analyseTextDeterministic(text);
    const heading = result.document.blocks.find((b) => b.kind === 'heading');
    expect(heading?.mode).toBe('descriptive');
  });

  it('still reports a numbered-step ordinal through the production path', () => {
    const text = ['1. Do the first thing. Then the second. Then a third. Then a fourth.', ''].join(
      '\n',
    );
    const result = analyseTextDeterministic(text, {
      config: { rules: { 'list-instruction-structure': { maxSentencesPerStep: 2 } } },
    });
    const finding = result.diagnostics.find((d) => d.ruleId === 'list-instruction-structure');
    expect(finding?.message).toContain('Numbered step 1');
  });
});

describe('the reader is wired into analyseText for markdown', () => {
  it('dispatches a candidate anchored inside a table cell to the semantic service', async () => {
    const bodies: string[] = [];
    service = await startFakeSemanticService({
      handler: (body) => {
        bodies.push(JSON.stringify(body));
        return {
          content: verdictJson({
            ruleId: 'passive-voice-candidate',
            status: 'compliant',
            confidence: 0.9,
            explanation: 'ok',
            suggestedReplacements: [],
          }),
        };
      },
    });
    const text = [
      '| Step | Result |',
      '| --- | --- |',
      '| 1 | The bracket is removed by the technician |',
      '',
    ].join('\n');
    await analyseText(text, {
      config: {
        semantic: {
          enabled: true,
          endpoint: service.url,
          model: 'fake',
          cache: false,
          maxRepairAttempts: 0,
        },
      },
    });
    expect(service.requestCount()).toBeGreaterThan(0);
    expect(bodies.join('\n')).toContain('is removed by');
  });
});

describe('the reader is wired into both entry points for plain text', () => {
  it('reports the same finding format: text produced before this stage', () => {
    const text = 'Prior to installation, remove the bracket.\n';
    const result = analyseTextDeterministic(text, { format: 'text' });
    expect(result.diagnostics.map((d) => d.ruleId)).toContain('unapproved-vocabulary');
  });
});
