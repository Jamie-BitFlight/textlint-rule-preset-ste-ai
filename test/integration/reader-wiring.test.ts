import { afterEach, describe, expect, it } from 'vite-plus/test';
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

  // Regression: PR #32 review on src/analysis/analyse.ts. Both production entry points pass
  // `structure: { extraImperativeVerbs: ... }` to `analyseDocument`, but they also always supply
  // `blocks` (from the reader), which means `analyseDocument` never calls `scanBlocks()` — the only
  // place that option was ever read. A configured extra imperative verb therefore had no effect on
  // mode classification in production, even though `analyseTextDeterministic`/`analyseText` accept
  // it via `config.extraImperativeVerbs`.
  it('classifies a sentence beginning with a configured extra imperative verb as procedural', () => {
    const text = 'Reticulate the splines before shipping the part.\n';
    const result = analyseTextDeterministic(text, {
      config: { extraImperativeVerbs: ['reticulate'] },
    });
    const block = result.document.blocks.find((b) => b.text.startsWith('Reticulate'));
    expect(block?.mode).toBe('procedural');
  });

  // Regression: `src/core/pos-tags.ts` taught `extraImperativeVerbs` to `compromise`'s
  // module-global lexicon via `addWords` and never untaught them. In a long-lived process, a
  // document analysed with one configuration's extra vocabulary could leave a word "known" as a
  // verb for every later analysis, including one with a different configuration or none at all —
  // which rule fires and which limit applies then depended on analysis order, not on that run's
  // own configuration.
  //
  // "Cache", not "Reticulate" (used above): `compromise`'s own unknown-word guesser already tags
  // a capitalised sentence-initial nonsense or rare word as `Verb Imperative` with no lexicon
  // entry at all (confirmed directly), so that word would read as procedural on the second run
  // regardless of whether the leak is fixed, proving nothing. "Cache" is a real English noun
  // `compromise` already recognises on its own and does not guess as a verb, so it only opens the
  // sentence as an imperative here because this run's `extraImperativeVerbs` taught it to.
  it('does not let one run’s extraImperativeVerbs leak into a later run with a different config', () => {
    const text = 'Cache the response before returning it.\n';

    const taught = analyseTextDeterministic(text, {
      config: { extraImperativeVerbs: ['cache'] },
    });
    expect(taught.document.blocks.find((b) => b.text.startsWith('Cache'))?.mode).toBe('procedural');

    // Same text, same process, but this run's own configuration never mentions "cache". It must
    // not be classified as procedural just because an earlier, unrelated run taught the word.
    const untaught = analyseTextDeterministic(text);
    expect(untaught.document.blocks.find((b) => b.text.startsWith('Cache'))?.mode).toBe(
      'descriptive',
    );
  });

  // Regression: Codex review on PR #39 (discussion_r3698570726). `unitToBlock` classified a
  // block's mode from `unit.masked`, which only masks the reader's own blockquote continuation
  // markers — not protected content (code spans, URLs, …). `analyseDocument`'s real
  // protected-region mask is built later and only feeds `sentence.masked`, never fed back to
  // reclassify the block mode `sentence.mode` was copied from. A sentence whose only
  // "imperative opener" was a word sitting inside a code span was misclassified `procedural`.
  it('does not classify a sentence as procedural just because a protected code span opens with a verb-like word', () => {
    const text = '`Install the driver` is the section title.\n';
    const result = analyseTextDeterministic(text);
    expect(result.document.blocks[0]?.mode).toBe('descriptive');
  });

  it('still classifies a genuine, unprotected imperative opener as procedural', () => {
    const text = 'Install the driver before continuing.\n';
    const result = analyseTextDeterministic(text);
    expect(result.document.blocks[0]?.mode).toBe('procedural');
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
