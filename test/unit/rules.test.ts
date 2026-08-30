import { describe, expect, it } from 'vite-plus/test';
import { resolveConfig, type SteAiConfigInput } from '../../src/core/config.js';
import { analyseDocument } from '../../src/core/document.js';
import { runDeterministicRules } from '../../src/core/runner.js';
import type { Diagnostic, DocumentFormat } from '../../src/core/types.js';
import { deterministicRules } from '../../src/deterministic/index.js';
import {
  findCaseConflicts,
  reportUncheckedGroup,
  type IssueReporter,
} from '../../src/deterministic/helpers.js';
import { provisionalRulePack } from '../../src/rule-pack/provisional-pack.js';

interface RunResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly text: string;
  quotesFor(ruleId: string): string[];
  forRule(ruleId: string): Diagnostic[];
}

function run(
  text: string,
  config: SteAiConfigInput = {},
  format: DocumentFormat = 'markdown',
): RunResult {
  const resolved = resolveConfig(config);
  const doc = analyseDocument(
    { id: 't', format, text },
    {
      protectedRegions: {
        approvedTerms: resolved.approvedTerms,
        extraPatterns: resolved.extraProtectedPatterns,
      },
      structure: { extraImperativeVerbs: resolved.extraImperativeVerbs },
    },
  );
  const result = runDeterministicRules({
    doc,
    rules: deterministicRules,
    config: resolved,
    pack: provisionalRulePack,
  });
  return {
    diagnostics: result.diagnostics,
    text,
    forRule: (ruleId) => result.diagnostics.filter((d) => d.ruleId === ruleId),
    quotesFor: (ruleId) =>
      result.diagnostics
        .filter((d) => d.ruleId === ruleId)
        .map((d) => text.slice(d.range.start, d.range.end)),
  };
}

describe('sentence-length-procedural', () => {
  const id = 'sentence-length-procedural';

  it('flags a genuinely complex instruction (long clauses, uncommon vocabulary)', () => {
    // 23 words, Flesch-Kincaid grade ~25 on masked text: nested relative clauses and low-frequency
    // vocabulary, not just length.
    const complex =
      'Verify that the subsystem, whose initialization sequence remains contingent upon a ' +
      'successfully negotiated authentication handshake, is not exhibiting nondeterministic ' +
      'behavior before you proceed.\n';
    expect(run(complex).forRule(id)).toHaveLength(1);
  });

  it('does not flag a short sentence regardless of vocabulary (below the readability floor)', () => {
    // Below the bundled `sentenceReadabilityFloorWords` (20), the grade-level formula is never
    // computed at all -- a sentence this short is presumed simple even though it is dense with
    // low-frequency words that would score a high grade if it were evaluated.
    const shortButJargonHeavy = 'Ascertain the aforementioned handshake prerequisite.\n';
    expect(run(shortButJargonHeavy).forRule(id)).toHaveLength(0);
  });

  it('flags a plain-but-dense instruction the old word-count rule would have missed', () => {
    // 20 words -- at the old bundled word limit, so the word-count rule never fired on it -- but
    // its Flesch-Kincaid grade level (masked) is already ~8.7, above the bundled procedural
    // threshold of 7. This is the flip side of the metric swap: some sentences that stayed under
    // the radar on word count alone are hard to read for reasons word count cannot see.
    const atOldWordLimit =
      'Remove the panel from the front of the enclosure before you continue with the next part of this task now.\n';
    const doc = analyseDocument({ id: 't', format: 'markdown', text: atOldWordLimit });
    expect(doc.sentences[0]?.words).toHaveLength(20);
    expect(run(atOldWordLimit).forRule(id)).toHaveLength(1);
  });

  it(
    'does not flag a long instruction made of enumerated identifiers (hard-negative concern), ' +
      'though the old word-count rule would have flagged it',
    () => {
      // 21 words: over the *old* 20-word procedural limit, so the pure word-count rule would have
      // flagged this. Scored on masked text, the identifiers contribute almost no syllables, so
      // the measured Flesch-Kincaid grade is ~2 -- far below the bundled threshold.
      const identifierHeavy =
        'Set the cache_size, busy_timeout, journal_mode, synchronous, wal_autocheckpoint, ' +
        'foreign_keys, secure_delete, temp_store, mmap_size, page_size, auto_vacuum, and ' +
        'cache_spill values to their documented defaults now.\n';
      const doc = analyseDocument({ id: 't', format: 'markdown', text: identifierHeavy });
      expect(doc.sentences[0]?.words.length).toBeGreaterThan(20);
      expect(run(identifierHeavy).forRule(id)).toHaveLength(0);
    },
  );

  it('respects a configured grade-level limit and floor', () => {
    // Aggressive overrides force the check onto a sentence the bundled defaults would ignore.
    const text = 'Remove the panel and then continue.\n';
    expect(run(text).forRule(id)).toHaveLength(0);
    expect(
      run(text, { rules: { [id]: { floorWords: 1, maxGradeLevel: 5 } } }).forRule(id),
    ).toHaveLength(1);
  });

  it('ignores headings by default and includes them when configured', () => {
    const heading = `# Install the panel and the bracket and the cover and the frame and the plate now\n`;
    expect(run(heading).forRule('sentence-length-descriptive')).toHaveLength(0);
    expect(
      run(heading, {
        rules: {
          'sentence-length-descriptive': { includeHeadings: true, floorWords: 5, maxGradeLevel: 5 },
        },
      }).forRule('sentence-length-descriptive'),
    ).toHaveLength(1);
  });

  it('still reports a long sentence that contains protected content', () => {
    // Regression: an earlier implementation dropped any diagnostic whose span merely overlapped a
    // protected region, which silently discarded every sentence-length finding for sentences
    // containing a quantity, an identifier or an inline code span. This sentence mixes protected
    // content with enough ordinary prose that its masked-text grade level still clears the bundled
    // threshold.
    const text =
      'Torque each of the four M6 bolts to 25 Nm and then run `make verify` before you refit the ' +
      'upper access cover and the lower access cover.\n';
    const result = run(text);
    expect(result.forRule(id)).toHaveLength(1);
    expect(
      result.text.slice(result.forRule(id)[0]?.range.start, result.forRule(id)[0]?.range.end),
    ).toContain('Torque each of the four');
  });
});

describe('sentence-length-descriptive', () => {
  const id = 'sentence-length-descriptive';

  it('applies the descriptive limit to genuinely complex descriptive prose', () => {
    const text =
      'The controller monitors the supply voltage and the ambient temperature and then reports both of these values to the host system over the diagnostic bus once every second.\n';
    const result = run(text);
    expect(result.forRule(id)).toHaveLength(1);
    expect(result.forRule('sentence-length-procedural')).toHaveLength(0);
  });

  it(
    'does not flag a long descriptive sentence made of enumerated identifiers (hard-negative ' +
      'concern), though the old word-count rule would have flagged it',
    () => {
      // 26 words: over the *old* 25-word descriptive limit. Masked-text Flesch-Kincaid grade is
      // ~2.8, far below the bundled descriptive threshold of 8.
      const identifierHeavy =
        'The diagnostic log records cache_size, busy_timeout, journal_mode, synchronous, ' +
        'wal_autocheckpoint, foreign_keys, secure_delete, temp_store, mmap_size, page_size, ' +
        'auto_vacuum, cache_spill, recursive_triggers, legacy_alter_table, ' +
        'reverse_unordered_selects, short_column_names, and read_uncommitted for every open ' +
        'session.\n';
      const doc = analyseDocument({ id: 't', format: 'markdown', text: identifierHeavy });
      expect(doc.sentences[0]?.words.length).toBeGreaterThan(25);
      expect(run(identifierHeavy).forRule(id)).toHaveLength(0);
    },
  );

  it('flags a genuinely complex descriptive sentence regardless of identifiers present', () => {
    const text =
      'Notwithstanding the aforementioned configuration constraints, the subsystem, whose ' +
      'initialization sequence is contingent upon prior successful negotiation of an ' +
      'authenticated handshake protocol, may nevertheless exhibit nondeterministic behavior ' +
      'under sustained concurrent load.\n';
    expect(run(text).forRule(id)).toHaveLength(1);
  });
});

describe('unapproved-vocabulary', () => {
  const id = 'unapproved-vocabulary';

  it('flags a listed word and offers the alternative', () => {
    const result = run('Utilise the bracket.\n');
    expect(result.quotesFor(id)).toEqual(['Utilise']);
    expect(result.forRule(id)[0]?.suggestions).toEqual(['use']);
  });

  it('attaches a fix only for a pack entry marked meaning-preserving', () => {
    expect(run('Utilise the bracket.\n').forRule(id)[0]?.fix?.text).toBe('Use');
    expect(run('Commence the test.\n').forRule(id)[0]?.fix).toBeUndefined();
  });

  it('prefers the longest matching phrase', () => {
    expect(run('Prior to the test, stop the pump.\n').quotesFor(id)).toEqual(['Prior to']);
  });

  it('never matches inside protected content', () => {
    expect(run('Run `utilise --now` and open /opt/utilise/bin.\n').forRule(id)).toHaveLength(0);
  });

  it('honours an allow list and additional terms', () => {
    expect(
      run('Utilise it.\n', { rules: { [id]: { allow: ['utilise'] } } }).forRule(id),
    ).toHaveLength(0);
    const extra = run('Leverage the API.\n', {
      rules: { [id]: { additional: { leverage: ['use'] } } },
    });
    expect(extra.quotesFor(id)).toEqual(['Leverage']);
    expect(extra.forRule(id)[0]?.fix).toBeUndefined();
  });

  it('preserves capitalisation in the fix', () => {
    expect(run('WHILST the pump runs, wait.\n').forRule(id)[0]?.fix?.text).toBe('WHILE');
  });
});

describe('preferred-terminology', () => {
  const id = 'preferred-terminology';

  it('flags a non-preferred spelling and fixes it', () => {
    const result = run('Open the web site now.\n');
    expect(result.quotesFor(id)).toEqual(['web site']);
    expect(result.forRule(id)[0]?.fix?.text).toBe('website');
  });

  it('reports without a fix when the pack marks the entry unsafe', () => {
    const result = run('The start-up sequence runs.\n');
    expect(result.forRule(id)[0]?.fix).toBeUndefined();
  });
});

/**
 * Runs a fixed document, exposing notices that the `run()` helper above discards. The second
 * sentence carries a contraction so `no-contractions` -- unrelated to `additional`'s own conflict
 * -- has something to genuinely find, not just something it happens not to flag.
 */
function runRaw(config: SteAiConfigInput) {
  const resolved = resolveConfig(config);
  const doc = analyseDocument({
    id: 't',
    format: 'markdown',
    text: "Use the tool. Don't touch the busbar.\n",
  });
  return runDeterministicRules({
    doc,
    rules: deterministicRules,
    config: resolved,
    pack: provisionalRulePack,
  });
}

/**
 * `additional` keys are matched case-insensitively (`termPattern()` in `src/deterministic/
 * helpers.ts`), so `Use` and `use` claim the same span. Before #125's fix, JSON key order silently
 * decided which alternatives list applied.
 */
describe('case-equivalent "additional" keys are rejected, not silently order-dependent (#125)', () => {
  it('rejects conflicting case-equivalent keys in unapproved-vocabulary, both key orders', () => {
    const orderA = runRaw({
      rules: {
        'unapproved-vocabulary': { additional: { Use: ['employ'], use: ['apply'] } },
      },
    });
    const orderB = runRaw({
      rules: {
        'unapproved-vocabulary': { additional: { use: ['apply'], Use: ['employ'] } },
      },
    });

    for (const result of [orderA, orderB]) {
      expect(result.diagnostics.some((d) => d.ruleId === 'unapproved-vocabulary')).toBe(false);
      const notice = result.notices.find((n) => n.code === 'rule-options-invalid');
      expect(notice?.detail).toEqual({ ruleId: 'unapproved-vocabulary' });
      expect(notice?.message).toContain('"Use"');
      expect(notice?.message).toContain('"use"');
    }
  });

  it('accepts case-equivalent keys that resolve to the same alternatives', () => {
    const result = runRaw({
      rules: {
        'unapproved-vocabulary': { additional: { Use: ['employ'], use: ['employ'] } },
      },
    });

    expect(result.notices.some((n) => n.code === 'rule-options-invalid')).toBe(false);
    expect(result.diagnostics.some((d) => d.ruleId === 'unapproved-vocabulary')).toBe(true);
  });

  it('does not reject a conflict whose keys are both disabled via allow (Codex review)', () => {
    // `run()` filters `additional` entries through `allow` (case-insensitively) before matching,
    // so `{ additional: { Use: [...], use: [...] }, allow: ['use'] }` has no runtime ambiguity at
    // all: neither key ever reaches `findTerm`. Validating the unfiltered map rejected this
    // perfectly valid configuration on a conflict that can never actually occur.
    const result = runRaw({
      rules: {
        'unapproved-vocabulary': {
          additional: { Use: ['employ'], use: ['apply'] },
          allow: ['use'],
        },
      },
    });

    expect(result.notices.some((n) => n.code === 'rule-options-invalid')).toBe(false);
  });

  it('still rejects a conflict when allow disables only one of the two keys', () => {
    // Filtering must be case-insensitive and per-key, not "any entry present in allow clears the
    // whole map": disabling `Use` alone leaves `use` on its own, so there is no conflict left
    // either -- this proves the filter narrows to the *other* remaining key correctly, not that it
    // happens to clear everything whenever `allow` is non-empty.
    const result = runRaw({
      rules: {
        'unapproved-vocabulary': {
          additional: { Use: ['employ'], use: ['apply'], leverage: ['employ'] },
          allow: ['leverage'],
        },
      },
    });

    const notice = result.notices.find((n) => n.code === 'rule-options-invalid');
    expect(notice?.message).toContain('"Use"');
    expect(notice?.message).toContain('"use"');
  });

  it('rejects conflicting case-equivalent keys in preferred-terminology, both key orders', () => {
    const orderA = runRaw({
      rules: {
        'preferred-terminology': { additional: { Use: 'employ', use: 'apply' } },
      },
    });
    const orderB = runRaw({
      rules: {
        'preferred-terminology': { additional: { use: 'apply', Use: 'employ' } },
      },
    });

    for (const result of [orderA, orderB]) {
      expect(result.diagnostics.some((d) => d.ruleId === 'preferred-terminology')).toBe(false);
      const notice = result.notices.find((n) => n.code === 'rule-options-invalid');
      expect(notice?.detail).toEqual({ ruleId: 'preferred-terminology' });
    }
  });

  it('does not reject unrelated rules when one rule’s additional map conflicts', () => {
    const result = runRaw({
      rules: {
        'unapproved-vocabulary': { additional: { Use: ['employ'], use: ['apply'] } },
      },
    });

    // The malformed rule is skipped; every other rule still ran (mirrors the `unknown-rule-id`
    // degrade-not-fail contract in `test/unit/config-strictness.test.ts`). `no-contractions` has a
    // real contraction to find in `runRaw`'s fixture text, so this proves it actually ran rather
    // than merely failing to flag text it was never going to flag anyway.
    expect(result.notices.filter((n) => n.level === 'error')).toHaveLength(1);
    expect(result.diagnostics.some((d) => d.ruleId === 'no-contractions')).toBe(true);
  });

  it('sanitizes the conflicting keys before naming them in the notice message', () => {
    // A pack's own `rules[].options` field is an unconstrained `z.record(z.string(),
    // z.unknown())` (`rulePackRuleSpecSchema` in `src/rule-pack/schema.ts`) and is merged as the
    // base of `rawOptions` before schema validation (`src/core/runner.ts`), so a case-conflicting
    // `additional` key can itself be pack-controlled, not just operator-typed. The notice message
    // is rendered verbatim by the CLI and by the textlint adapter's run-level notice reporting, so
    // it needs the same control-character/bidi-override stripping as `Diagnostic.message`.
    //
    // The bidi-override character sits *inside* both keys, at the same position, so the keys stay
    // case-equivalent (`.toLowerCase()` doesn't touch it) -- appending it only to one key instead
    // would make the two keys genuinely different strings, not case variants, and the conflict
    // detector would never fire at all.
    const bidiOverride = String.fromCharCode(0x202e);
    const keyA = `U${bidiOverride}se`;
    const keyB = `u${bidiOverride}se`;
    const result = runRaw({
      rules: {
        'unapproved-vocabulary': { additional: { [keyA]: ['employ'], [keyB]: ['apply'] } },
      },
    });

    const notice = result.notices.find((n) => n.code === 'rule-options-invalid');
    expect(notice?.message).toBeDefined();
    expect(notice?.message).not.toContain(bidiOverride);
    expect(notice?.message).toContain('"Use"');
    expect(notice?.message).toContain('"use"');
  });

  it('catches a Unicode case fold "toLowerCase()" itself does not compute', () => {
    // `termPattern()`'s `/iu` flag matches on full Unicode case folding, which is a different,
    // stricter relation than `String.prototype.toLowerCase()` computes -- confirmed directly:
    // `/s/iu` matches the Latin small letter long s (`ſ`, U+017F), a real span collision, but
    // `'s'.toLowerCase() !== 'ſ'.toLowerCase()`. A conflict detector keyed on `toLowerCase()`
    // would silently miss this pair, leaving exactly the object-key-order ambiguity #125 exists
    // to reject.
    const result = runRaw({
      rules: {
        'unapproved-vocabulary': { additional: { s: ['sierra'], ſ: ['long-s'] } },
      },
    });

    const notice = result.notices.find((n) => n.code === 'rule-options-invalid');
    expect(notice?.message).toBeDefined();
    expect(notice?.detail).toEqual({ ruleId: 'unapproved-vocabulary' });
  });

  it('stays fast and correct on a large map, without exhaustively scanning every length', () => {
    // Direct call, not through a rule: constructing a document config with 600 `additional`
    // entries through the full pipeline just to exercise this one internal boundary would be
    // unwieldy for no extra coverage. `findCaseConflicts` only pays its pairwise `sameTermSpan`
    // cost within a bucket of same-code-point-length keys, bounded by
    // `EXHAUSTIVE_FOLD_SCAN_LIMIT_PER_LENGTH`. `word0`..`word599` spread across four lengths
    // (5-8 digits), each bucket comfortably under the limit, so `Foo`/`foo` (the only length-3
    // pair) still gets a real, confirmed conflict check.
    const additional: Record<string, string[]> = { Foo: ['first'], foo: ['second'] };
    for (let i = 0; i < 600; i++) additional[`word${i}`] = [`alt${i}`];

    const started = Date.now();
    const scan = findCaseConflicts(additional, (a, b) => JSON.stringify(a) === JSON.stringify(b));
    const elapsedMs = Date.now() - started;

    expect(scan.conflicts).toEqual([['Foo', 'foo']]);
    expect(scan.unchecked).toEqual([]);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('rejects an oversized length bucket instead of silently passing it (Codex review)', () => {
    // Silently treating a bucket too large to check exhaustively as conflict-free was the first
    // version of this bound -- rejected on review, because that bucket could still contain a
    // genuine conflict (`Foo`/`foo` here, buried among 500 unrelated four-code-point keys) and
    // reporting "no conflict" without having actually checked is a false all-clear. This proves
    // the corrected behavior: the oversized bucket comes back as `unchecked`, not silently
    // dropped, regardless of whether it happens to contain a real conflict.
    // Every filler key is exactly 3 code points, the same length as "Foo"/"foo", so they land in
    // the one oversized bucket together: 500 filler keys ("000".."499") plus the real pair, 502
    // entries total, comfortably over `EXHAUSTIVE_FOLD_SCAN_LIMIT_PER_LENGTH` (500).
    const additional: Record<string, string[]> = { Foo: ['first'], foo: ['second'] };
    for (let i = 0; i < 500; i++) additional[String(i).padStart(3, '0')] = [`alt${i}`];

    const scan = findCaseConflicts(additional, (a, b) => JSON.stringify(a) === JSON.stringify(b));

    expect(scan.conflicts).toEqual([]);
    expect(scan.unchecked).toHaveLength(1);
    expect(scan.unchecked[0]?.reason).toBe('bucket-too-large');
    expect(scan.unchecked[0]?.keys).toHaveLength(502);
    expect(scan.unchecked[0]?.keys).toEqual(expect.arrayContaining(['Foo', 'foo']));
  });

  it('bounds total cost across many buckets, not just within one (Codex review)', () => {
    // The per-length bound alone does not stop an untrusted pack from keeping every bucket at
    // exactly the per-length limit and supplying arbitrarily many buckets: 50 distinct lengths,
    // 500 entries each (25,000 keys total, every individual bucket within
    // `EXHAUSTIVE_FOLD_SCAN_LIMIT_PER_LENGTH`) reproduces the adversarial shape `MAX_TOTAL_COMPARISONS`
    // exists to bound.
    const additional: Record<string, string[]> = {};
    for (let bucket = 0; bucket < 50; bucket++) {
      const prefix = 'x'.repeat(bucket);
      for (let i = 0; i < 500; i++)
        additional[`${prefix}${String(i).padStart(3, '0')}`] = [`v${i}`];
    }

    const started = Date.now();
    const scan = findCaseConflicts(additional, (a, b) => JSON.stringify(a) === JSON.stringify(b));
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(2000);
    // At least one bucket exceeded the total budget and came back unchecked rather than being
    // silently treated as conflict-free.
    expect(scan.unchecked.length).toBeGreaterThan(0);
    expect(scan.unchecked.some((group) => group.reason === 'total-budget-exceeded')).toBe(true);
  });

  it('reports a total-budget overflow as its own reason, not "bucket too large" (Codex review)', () => {
    // Four buckets sitting exactly at the per-length limit (500 * 499 / 2 = 124,750 comparisons
    // each) spend 499,000 of the 500,000-comparison total budget between them. A fifth, much
    // smaller bucket (50 entries, nowhere near the per-length limit) then pushes the running total
    // over budget by itself. Before distinguishing the two reasons, both this small bucket and a
    // genuinely oversized one shared one `unchecked` shape, and `reportUncheckedGroup` always
    // claimed "too many keys share this length" -- wrong for this bucket, which isn't oversized at
    // all, just the one that happened to cross a budget earlier buckets already spent most of.
    const additional: Record<string, string[]> = {};
    for (let bucket = 0; bucket < 4; bucket++) {
      const prefix = 'x'.repeat(bucket);
      for (let i = 0; i < 500; i++)
        additional[`${prefix}${String(i).padStart(3, '0')}`] = [`v${i}`];
    }
    const smallPrefix = 'x'.repeat(10);
    for (let i = 0; i < 50; i++)
      additional[`${smallPrefix}${String(i).padStart(2, '0')}`] = [`s${i}`];

    const scan = findCaseConflicts(additional, (a, b) => JSON.stringify(a) === JSON.stringify(b));

    const smallBucket = scan.unchecked.find((group) => group.keys.length === 50);
    expect(smallBucket?.reason).toBe('total-budget-exceeded');

    const notices: string[] = [];
    const ctx: IssueReporter = { addIssue: (issue) => notices.push(issue.message) };
    if (smallBucket !== undefined) reportUncheckedGroup(ctx, smallBucket, 'alternatives');
    expect(notices[0]).toContain('total comparison budget');
    expect(notices[0]).not.toContain('too many to exhaustively check');
  });

  it('bounds total cost by key length as well as comparison count (Codex review)', () => {
    // MAX_TOTAL_COMPARISONS alone assumes every comparison costs the same, but a regex match's
    // cost scales with the length of the strings it matches -- a bucket comfortably within both
    // the per-bucket limit (500) and the total pair-count budget (500,000) can still be expensive
    // if its keys are individually very long. 500 keys of 201 code points each: 124,750 pairs,
    // under every count-based limit, but 124,750 * 201 code points of matching work exceeds
    // MAX_TOTAL_COMPARISON_WORK, so this reproduces the shape the budget exists to reject rather
    // than asserting a specific measured duration that would drift from the real cost over time.
    const additional: Record<string, string[]> = {};
    for (let i = 0; i < 500; i++) {
      const key = `${String(i).padStart(3, '0')}${'x'.repeat(198)}`;
      additional[key] = [`v${i}`];
    }

    const scan = findCaseConflicts(additional, (a, b) => JSON.stringify(a) === JSON.stringify(b));

    expect(scan.unchecked).toHaveLength(1);
    expect(scan.unchecked[0]?.reason).toBe('total-budget-exceeded');
    expect(scan.unchecked[0]?.keys).toHaveLength(500);
  });

  it('charges the work budget for uncollapsed whitespace, not the bucketed length (Codex review)', () => {
    // codePointLength collapses a whitespace run to one unit for bucketing, matching how
    // sameTermSpan's \s+ actually treats it -- but escapeForMatching/sameTermSpan still scan every
    // raw whitespace character on each comparison, so a key built mostly of whitespace bucketed as
    // short. Charging the work budget off that collapsed length let this shape slip under it: 500
    // keys of a letter, three digits, three thousand spaces, and "x" all bucket at the same short
    // collapsed length (6), but the raw length actually scanned per comparison is over 3,000.
    const additional: Record<string, string[]> = {};
    for (let i = 0; i < 500; i++) {
      const key = `${String.fromCharCode(65 + (i % 26))}${String(i).padStart(3, '0')}${' '.repeat(3000)}x`;
      additional[key] = [`v${i}`];
    }

    const scan = findCaseConflicts(additional, (a, b) => JSON.stringify(a) === JSON.stringify(b));

    expect(scan.unchecked).toHaveLength(1);
    expect(scan.unchecked[0]?.reason).toBe('total-budget-exceeded');
    expect(scan.unchecked[0]?.keys).toHaveLength(500);
  });

  it('charges the work budget for untrimmed leading/trailing whitespace too (Codex review)', () => {
    // The raw-length fix above measured Array.from(item[0].trim()).length -- trimming before
    // counting hid exactly the whitespace that costs time: escapeForMatching's own .trim() call,
    // and sameTermSpan's b.trim(), each scan the full untrimmed string regardless of how much they
    // end up stripping. 500 distinct three-character keys each followed by 3,000 trailing spaces
    // all bucket at the same short trimmed length (3), so a length charge that also trims hides
    // the real per-comparison re-trim cost the same way the internal-whitespace case did above.
    const additional: Record<string, string[]> = {};
    for (let i = 0; i < 500; i++) {
      const key = `${String(i).padStart(3, '0')}${' '.repeat(3000)}`;
      additional[key] = [`v${i}`];
    }

    const scan = findCaseConflicts(additional, (a, b) => JSON.stringify(a) === JSON.stringify(b));

    expect(scan.unchecked).toHaveLength(1);
    expect(scan.unchecked[0]?.reason).toBe('total-budget-exceeded');
    expect(scan.unchecked[0]?.keys).toHaveLength(500);
  });

  it('degrades to unchecked instead of crashing when a key is too long to compile (Codex review)', () => {
    // sameTermSpan compiles a RegExp from each key. Neither MAX_TOTAL_COMPARISONS nor
    // MAX_TOTAL_COMPARISON_WORK catches two case-fold-equivalent keys that are each merely very
    // long: a bucket of two costs one comparison, comfortably under both budgets, yet the
    // underlying regex engine refuses to compile a pattern past its own internal size limit --
    // 50,000 code points is comfortably past that limit on the engine running this test. Uncaught,
    // that exception would escape this function, the superRefine callback calling it, and
    // safeParse itself, crashing the whole run instead of degrading to the rule-options-invalid
    // this rule is supposed to produce.
    const additional: Record<string, string[]> = {
      [`a${'x'.repeat(50_000)}`]: ['first'],
      [`A${'x'.repeat(50_000)}`]: ['second'],
    };

    const scan = findCaseConflicts(additional, (a, b) => JSON.stringify(a) === JSON.stringify(b));

    expect(scan.conflicts).toEqual([]);
    expect(scan.unchecked).toHaveLength(1);
    expect(scan.unchecked[0]?.reason).toBe('comparison-failed');
    expect(scan.unchecked[0]?.keys).toHaveLength(2);
  });

  it('also catches a too-long key with no peer to compare it against (Codex review)', () => {
    // The fix above only exercised a key's own compile-safety when the pairwise loop happened to
    // use it as sameTermSpan's first argument -- a key alone in its length bucket never enters
    // that loop at all (there is no second entry to compare it against), so it passed through
    // untested and unchecked, the identical crash risk with no bucket-level catch anywhere near
    // it. Every key is now self-tested up front, regardless of whether it ends up compared to
    // anything.
    const additional: Record<string, string[]> = {
      [`a${'x'.repeat(50_000)}`]: ['only'],
    };

    const scan = findCaseConflicts(additional, (a, b) => JSON.stringify(a) === JSON.stringify(b));

    expect(scan.conflicts).toEqual([]);
    expect(scan.unchecked).toHaveLength(1);
    expect(scan.unchecked[0]?.reason).toBe('comparison-failed');
    expect(scan.unchecked[0]?.keys).toHaveLength(1);
  });

  it('never merges keys the real matcher treats as distinct (Codex review)', () => {
    // A cheap canonicalisation broad enough to unify every case `sameTermSpan` recognises (Greek
    // final sigma, the Latin long s) is also broad enough to over-merge: ASCII `A` and fullwidth
    // `Ａ` (U+FF21) both normalize+lowercase to `a`, but `termPattern`'s actual `/iu` regex does
    // not treat them as the same letter -- confirmed directly: `/^A$/iu.test('Ａ')` is `false`.
    // An earlier version of `findCaseConflicts` used exactly that canonicalisation as its
    // grouping and would have flagged this pair, incorrectly skipping the whole rule for two
    // keys that do not actually collide.
    const scan = findCaseConflicts({ A: ['alfa'], Ａ: ['fullwidth-a'] }, (a, b) => a === b);

    expect(scan.conflicts).toEqual([]);
  });

  it('bucket differing internal whitespace runs together (Codex review)', () => {
    // `escapeForMatching` turns every whitespace run into a flexible `\s+`, matching one or more
    // characters of any length on either side, so `"foo bar"` (one space) and `"foo  bar"` (two
    // spaces) are `sameTermSpan`-equivalent -- confirmed directly -- despite differing raw
    // code-point counts. A length-based prefilter keyed on raw code points would put them in
    // different buckets and never test them against each other, silently missing exactly the
    // "object key order decides" conflict #125 exists to reject, for a multi-word phrase.
    const scan = findCaseConflicts(
      { 'foo bar': ['first'], 'foo  bar': ['second'] },
      (a, b) => JSON.stringify(a) === JSON.stringify(b),
    );

    expect(scan.conflicts).toEqual([['foo bar', 'foo  bar']]);
  });
});

describe('no-contractions', () => {
  const id = 'no-contractions';

  it('expands an unambiguous contraction', () => {
    const result = run("Don't remove the cover.\n");
    expect(result.quotesFor(id)).toEqual(["Don't"]);
    expect(result.forRule(id)[0]?.fix?.text).toBe('Do not');
  });

  it('matches a typographic apostrophe', () => {
    expect(run('The unit doesn’t start.\n').quotesFor(id)).toEqual(['doesn’t']);
  });

  it('reports an ambiguous contraction without a fix', () => {
    const result = run("It's ready.\n");
    expect(result.forRule(id)[0]?.fix).toBeUndefined();
    expect(result.forRule(id)[0]?.message).toContain('Ambiguous');
  });

  it('ignores contractions inside code', () => {
    expect(run("Run `don't-care --flag` now.\n").forRule(id)).toHaveLength(0);
  });
});

describe('punctuation-constraints', () => {
  const id = 'punctuation-constraints';

  it('flags a semicolon', () => {
    // `toContain` alone would also pass if the rule over-flagged every punctuation character in
    // the sentence (e.g. the trailing period too), so assert the flagged set is exactly the
    // semicolon.
    expect(run('Stop the pump; close the valve.\n').quotesFor(id)).toEqual([';']);
  });

  it('flags a slash between words but not a path', () => {
    expect(run('Use the input/output board.\n').quotesFor(id)).toContain('/');
    expect(run('Open /etc/hosts now.\n').forRule(id)).toHaveLength(0);
  });

  it('flags an exclamation mark and an ellipsis', () => {
    expect(run('Stop now!\n').quotesFor(id)).toContain('!');
    expect(run('The value is set...\n').quotesFor(id)).toContain('...');
  });

  it('flags parentheses only inside an instruction', () => {
    expect(run('Remove the cover (see Fig. 2) now.\n').quotesFor(id)).toContain('(see Fig. 2)');
    expect(run('The cover (aluminium) is heavy.\n').quotesFor(id)).not.toContain('(aluminium)');
  });

  it('flags more commas than the limit', () => {
    const text = 'The board holds the relay, the fuse, the diode, the resistor, and the jumper.\n';
    expect(
      run(text)
        .forRule(id)
        .some((d) => d.meta?.['punctuation'] === 'commas'),
    ).toBe(true);
  });

  it('respects disabling individual checks', () => {
    // The semicolon is this sentence's only punctuation violation, so disabling it should leave
    // no diagnostics at all — a plain `not.toContain(';')` would also pass on an unrelated bug
    // that emptied every diagnostic array regardless of which check fired.
    expect(
      run('Stop the pump; close the valve.\n', {
        rules: { [id]: { forbidSemicolon: false } },
      }).forRule(id),
    ).toHaveLength(0);
  });
});

describe('no-repeated-words', () => {
  const id = 'no-repeated-words';

  it('flags and fixes a doubled word', () => {
    const result = run('Remove the the cover.\n');
    expect(result.quotesFor(id)).toEqual(['the the']);
    expect(result.forRule(id)[0]?.fix?.text).toBe('');
  });

  it('does not flag an allow-listed doubling', () => {
    expect(run('The value that that follows is set.\n').forRule(id)).toHaveLength(0);
  });

  it('refuses the fix when deleting would change negation', () => {
    const result = run('Do not not touch the busbar.\n');
    expect(result.forRule(id)).toHaveLength(1);
    expect(result.forRule(id)[0]?.fix).toBeUndefined();
    expect(result.forRule(id)[0]?.message).toContain('changes negation');
  });

  it('does not flag a repetition separated by punctuation', () => {
    expect(run('Stop. Stop the pump.\n').forRule(id)).toHaveLength(0);
  });
});

describe('abbreviation-introduction', () => {
  const id = 'abbreviation-introduction';

  it('flags an unintroduced abbreviation once', () => {
    const result = run('The ECU reports a fault. The ECU then halts.\n');
    expect(result.quotesFor(id)).toEqual(['ECU']);
  });

  it('accepts either introduction form', () => {
    expect(run('The Engine Control Unit (ECU) reports a fault.\n').forRule(id)).toHaveLength(0);
    expect(run('The ECU (Engine Control Unit) reports a fault.\n').forRule(id)).toHaveLength(0);
  });

  it('ignores well-known abbreviations and honours configuration', () => {
    expect(run('The API returns JSON over HTTPS.\n').forRule(id)).toHaveLength(0);
    expect(
      run('The ECU halts.\n', { rules: { [id]: { additionalWellKnown: ['ECU'] } } }).forRule(id),
    ).toHaveLength(0);
  });

  it('does not flag abbreviations that are inside protected content', () => {
    expect(run('Set `ECU_MODE` to 1.\n').forRule(id)).toHaveLength(0);
  });

  it('does not flag SQL keyword tokens used bare in prose with no config context', () => {
    const result = run(
      'Run VACUUM to reclaim space. Then run ANALYZE and PRAGMA integrity_check.\n',
    );
    expect(result.forRule(id)).toHaveLength(0);
  });

  it('does not flag a config-value token inside a quoted mid-sentence literal', () => {
    const result = run(
      'Unless running in "auto_vacuum=FULL" mode, the database keeps free pages.\n',
    );
    expect(result.forRule(id)).toHaveLength(0);
  });

  it('does not flag a config-value token inside an unquoted mid-sentence assignment', () => {
    expect(run('Set PRAGMA secure_delete=ON.\n').forRule(id)).toHaveLength(0);
  });

  it('does not flag RFC or FIPS used as a citation number', () => {
    // Note: the original bug report's sample sentence for RFC also contained "URI", a
    // genuinely unintroduced abbreviation unrelated to this fix, which would fail this
    // assertion for reasons that have nothing to do with citation-number handling — reworded
    // to isolate the citation-number behaviour under test.
    expect(run('See RFC 3986 for grammar rules.\n').forRule(id)).toHaveLength(0);
    expect(run('Enable FIPS 140-2 mode.\n').forRule(id)).toHaveLength(0);
  });

  it('does not flag a bare token corroborated by an identifier-shaped occurrence elsewhere in the document', () => {
    const result = run(
      'Set LLVM_ENABLE_PROJECTS to configure the build. Building LLVM from source takes a while.\n',
    );
    expect(result.forRule(id)).toHaveLength(0);
  });

  it('does not flag a bare token corroborated by a config-fragment occurrence elsewhere in the document', () => {
    const result = run(
      'Set journal_mode=WAL for better concurrency. WAL reduces write contention.\n',
    );
    expect(result.forRule(id)).toHaveLength(0);
  });

  it('still flags a genuinely fabricated, uncorroborated all-caps token', () => {
    const result = run('The ZQX module failed during startup.\n');
    expect(result.forRule(id)).toHaveLength(1);
    expect(result.forRule(id)[0]?.meta?.['abbreviation']).toBe('ZQX');
  });

  // Table-cell prose is treated identically to ordinary prose by the protected-region layer
  // (see test/unit/protected-regions.test.ts's 'protects table pipes but keeps cell prose
  // visible'), so this case is closed by the same config-fragment/corroboration mechanism as
  // the mid-sentence FULL/ON cases above, not by any table-specific logic.
  it('does not flag a false-positive token inside a markdown table cell', () => {
    const result = run('| Option | Value |\n| --- | --- |\n| Mode | auto_vacuum=FULL |\n');
    expect(result.forRule(id)).toHaveLength(0);
  });

  // `minLength`/`maxLength` are interpolated into a `{min,max}` regular-expression quantifier, so
  // an inverted pair is a regex syntax error rather than a merely useless setting. Each bound
  // satisfies its own range, so before the cross-field check the options parsed and the rule then
  // threw inside `run`, aborting analysis of the whole document (issue #6). The pair is now
  // rejected at parse time, which is the path the runner already handles.
  it('rejects an inverted minLength/maxLength pair at parse time instead of throwing', () => {
    const resolved = resolveConfig({
      rules: { [id]: { minLength: 8, maxLength: 3 } },
    });
    // The document also violates `unapproved-vocabulary`, so the run's completion is observable
    // rather than merely uneventful.
    const doc = analyseDocument({
      id: 't',
      format: 'markdown',
      text: 'Utilise the ABCDEFGH module.\n',
    });

    const result = runDeterministicRules({
      doc,
      rules: deterministicRules,
      config: resolved,
      pack: provisionalRulePack,
    });

    const notice = result.notices.find(
      (n) => n.code === 'rule-options-invalid' && n.detail?.['ruleId'] === id,
    );
    expect(notice).toBeDefined();
    expect(notice?.level).toBe('error');
    expect(notice?.message).toContain('maxLength');
    // Only this rule is skipped; the rest of the run still reports.
    expect(result.diagnostics.filter((d) => d.ruleId === id)).toHaveLength(0);
    expect(result.diagnostics.some((d) => d.ruleId === 'unapproved-vocabulary')).toBe(true);
  });

  it('accepts minLength equal to maxLength', () => {
    const result = run('The ZQX module failed. The ZQXY module also failed.\n', {
      rules: { [id]: { minLength: 3, maxLength: 3 } },
    });
    expect(result.quotesFor(id)).toEqual(['ZQX']);
  });
});

describe('number-unit-format', () => {
  const id = 'number-unit-format';

  it('flags a missing space between number and unit and never offers a fix', () => {
    const result = run('Torque the bolt to 25Nm now.\n');
    expect(result.forRule(id)).toHaveLength(1);
    expect(result.forRule(id)[0]?.fix).toBeUndefined();
    expect(result.forRule(id)[0]?.suggestions).toEqual(['25 Nm']);
  });

  it('accepts a correctly spaced quantity', () => {
    expect(run('Torque the bolt to 25 Nm now.\n').forRule(id)).toHaveLength(0);
  });

  it('does not require a space before a percent sign', () => {
    expect(run('Charge to 80% now.\n').forRule(id)).toHaveLength(0);
  });

  it('flags a decimal comma', () => {
    const result = run('Set the gap to 0,5 mm now.\n');
    expect(result.forRule(id).some((d) => d.meta?.['issue'] === 'decimal-comma')).toBe(true);
  });

  it('can require the opposite spacing convention', () => {
    const result = run('Torque the bolt to 25 Nm now.\n', {
      rules: { [id]: { unitSpacing: 'forbidden' } },
    });
    expect(result.forRule(id)).toHaveLength(1);
  });
});

describe('list-instruction-structure', () => {
  const id = 'list-instruction-structure';

  it('flags inconsistent terminal punctuation across sibling items', () => {
    const text = '- Remove the cover.\n- Remove the filter.\n- Install the new filter\n';
    expect(
      run(text)
        .forRule(id)
        .some((d) => d.meta?.['issue'] === 'terminal-punctuation'),
    ).toBe(true);
  });

  it('accepts a consistently punctuated list', () => {
    const text = '- Remove the cover.\n- Remove the filter.\n- Install the new filter.\n';
    expect(run(text).forRule(id)).toHaveLength(0);
  });

  it('flags a numbered step that contains more sentences than the limit', () => {
    const text = '1. Remove the cover. Then remove the filter.\n2. Install the new filter.\n';
    expect(
      run(text)
        .forRule(id)
        .some((d) => d.message.includes('sentences')),
    ).toBe(true);
  });

  it('flags inconsistent initial capitalisation', () => {
    const text = '- Remove the cover.\n- Remove the filter.\n- install the new filter.\n';
    expect(
      run(text)
        .forRule(id)
        .some((d) => d.meta?.['issue'] === 'initial-capital'),
    ).toBe(true);
  });
});

describe('one-instruction-per-sentence', () => {
  const id = 'one-instruction-per-sentence';

  it('flags two imperatives joined by "and"', () => {
    const result = run('Remove the cover and install the new filter.\n');
    expect(result.forRule(id)).toHaveLength(1);
    expect(result.forRule(id)[0]?.category).toBe('deterministic-violation');
  });

  it('flags "and then"', () => {
    expect(run('Loosen the clamp and then remove the sensor.\n').forRule(id)).toHaveLength(1);
  });

  it('does not flag one action on two objects', () => {
    expect(run('Remove the cover and the filter.\n').forRule(id)).toHaveLength(0);
  });

  it('does not flag descriptive prose', () => {
    expect(run('The unit reads the sensor and writes the value.\n').forRule(id)).toHaveLength(0);
  });

  it('emits review-required for a comma-joined clause when adjudication is off', () => {
    const result = run('Remove the cover, install the new filter.\n', {
      rules: { [id]: { adjudicate: false } },
    });
    expect(result.forRule(id).map((d) => d.category)).toEqual(['review-required']);
  });

  it('drops review-required diagnostics when the policy disables them', () => {
    const result = run('Remove the cover, install the new filter.\n', {
      rules: { [id]: { adjudicate: false } },
      diagnostics: { reportReviewRequired: false },
    });
    expect(result.forRule(id)).toHaveLength(0);
  });

  it('flags two imperatives joined by "and" using a verb the old hardcoded list never enumerated', () => {
    // Neither "wipe" nor "trim" is in `IMPERATIVE_VERBS` (src/core/imperative-verbs.ts) — this is
    // real recall from `compromise`'s grammatical tagging, not just parity with the closed list.
    const result = run('Wipe the sensor lens and trim the excess cable.\n');
    expect(result.forRule(id)).toHaveLength(1);
    expect(result.forRule(id)[0]?.category).toBe('deterministic-violation');
  });

  it('does not flag an inflected third-person verb inside a descriptive relative clause', () => {
    // Regression (chatgpt-codex-connector, P1): `compromise` tags a finite third-person verb such
    // as "sends" or "logs" as `Verb`+`PresentTense` without `Infinitive` — the same PresentTense
    // tag a genuine bare/base-form command verb carries. The old "is this a bare verb" check
    // accepted either signal alone, so the word after "and" in "which logs events and sends
    // reports" (itself part of a descriptive relative clause, not a second instruction) satisfied
    // it and this sentence was reported as containing two instructions, even though "sends" never
    // opens an imperative clause — confirmed directly: `compromise` tags "sends" `Verb
    // PresentTense` with no `Infinitive`, exactly like "logs", while a genuine second imperative
    // ("...and format the disk.") keeps `Infinitive` in the same position.
    const result = run('Install the agent, which logs events and sends reports.\n');
    expect(result.forRule(id)).toHaveLength(0);
  });
});

describe('candidate rules never assert violations', () => {
  it('passive-voice-candidate emits review-required, not a violation', () => {
    const result = run('The filter must be replaced every 500 hours.\n', {
      rules: { 'passive-voice-candidate': { adjudicate: false } },
    });
    const passive = result.forRule('passive-voice-candidate');
    expect(passive).toHaveLength(1);
    expect(result.text.slice(passive[0]?.range.start, passive[0]?.range.end)).toBe('be replaced');
    expect(passive.every((d) => d.category === 'review-required')).toBe(true);
  });

  it('passive-voice-candidate can require an explicit agent', () => {
    const withAgent = run('The bolts are tightened by the technician.\n', {
      rules: { 'passive-voice-candidate': { adjudicate: false, requireByAgent: true } },
    });
    const withoutAgent = run('The drain valve is closed.\n', {
      rules: { 'passive-voice-candidate': { adjudicate: false, requireByAgent: true } },
    });
    expect(withAgent.forRule('passive-voice-candidate').length).toBe(1);
    expect(withoutAgent.forRule('passive-voice-candidate')).toHaveLength(0);
  });

  it('passive-voice-candidate still catches an ordinary irregular participle from the old list', () => {
    // "known" is in the old 70-entry `PARTICIPLES` list, and wink-nlp independently tags it VERB
    // here — the wink-nlp check is a filter added on top of the unchanged shape gate (regular
    // `-ed` word or `PARTICIPLES` membership), not a replacement for it: see the "Known gap found,
    // not fixed here" note on `isPassiveParticiple` in candidate-rules.ts for why a genuinely novel
    // irregular participle outside that list ("hewn", "forsaken" — wink-nlp tags both VERB, and
    // neither is in `PARTICIPLES`) is deliberately not admitted by this prototype: it would emit a
    // candidate span no reviewer has ever adjudicated.
    const result = run('The value is known.\n', {
      rules: { 'passive-voice-candidate': { adjudicate: false } },
    });
    const passive = result.forRule('passive-voice-candidate');
    expect(passive).toHaveLength(1);
    expect(result.text.slice(passive[0]?.range.start, passive[0]?.range.end)).toBe('is known');
  });

  it('passive-voice-candidate no longer flags the exact adjectival case the corpus reviewer named', () => {
    // "is disabled" in this shape ("By default X is disabled") is the corpus's own example of a
    // configuration-state reading, not a passive action (httpd-mod-ssl-directive-config.json).
    // wink-nlp tags "disabled" ADJ here, so the tag-conditioned check does not generate a
    // candidate at all — a real behaviour change from the old regex, which matched any `-ed`
    // word and relied on semantic adjudication to call it a non-violation.
    const result = run('By default the SSL Engine is disabled.\n', {
      rules: { 'passive-voice-candidate': { adjudicate: false } },
    });
    expect(result.forRule('passive-voice-candidate')).toHaveLength(0);
  });

  it('noun-cluster-candidate flags a long run of content words', () => {
    const result = run('Check the engine oil pressure warning lamp test procedure.\n', {
      rules: { 'noun-cluster-candidate': { adjudicate: false } },
    });
    const clusters = result.forRule('noun-cluster-candidate');
    expect(clusters).toHaveLength(1);
    expect(result.text.slice(clusters[0]?.range.start, clusters[0]?.range.end)).toBe(
      'engine oil pressure warning lamp test procedure',
    );
  });

  it('noun-cluster-candidate leaves a short cluster alone', () => {
    expect(
      run('Check the oil pressure lamp.\n', {
        rules: { 'noun-cluster-candidate': { adjudicate: false } },
      }).forRule('noun-cluster-candidate'),
    ).toHaveLength(0);
  });

  it('noun-cluster-candidate still breaks a run on "no", which compromise mistags as Expression', () => {
    // Regression guard: `compromise` tags "no" as `Expression` rather than `Determiner`/`Negative`
    // in ordinary sentence context (confirmed directly against fixtures/original), so
    // `isFunctionWord` must still catch it via the closed-class list, not rely on the tag alone.
    const result = run('Check the engine has no oil pressure warning lamp fault today.\n', {
      rules: { 'noun-cluster-candidate': { adjudicate: false } },
    });
    const clusters = result.forRule('noun-cluster-candidate');
    expect(clusters.length).toBeGreaterThan(0);
    for (const cluster of clusters) {
      const text = result.text.slice(cluster.range.start, cluster.range.end);
      expect(text.toLowerCase().split(/\s+/)).not.toContain('no');
    }
  });

  it('ambiguous-pronoun-candidate flags a bare demonstrative subject', () => {
    const result = run('The pump runs for ten seconds. This prevents cavitation.\n', {
      rules: { 'ambiguous-pronoun-candidate': { adjudicate: false } },
    });
    const quotes = result.quotesFor('ambiguous-pronoun-candidate');
    expect(quotes).toContain('This');
  });

  it('ambiguous-pronoun-candidate flags a pronoun with several antecedents', () => {
    const result = run('Connect the sensor to the controller. It must be earthed.\n', {
      rules: { 'ambiguous-pronoun-candidate': { adjudicate: false } },
    });
    expect(result.quotesFor('ambiguous-pronoun-candidate')).toContain('It');
  });
});

describe('runner invariants', () => {
  it('a disabled rule produces nothing', () => {
    expect(
      run('Utilise the bracket.\n', {
        rules: { 'unapproved-vocabulary': { enabled: false } },
      }).forRule('unapproved-vocabulary'),
    ).toHaveLength(0);
  });

  it('a severity override is applied', () => {
    const result = run('Utilise the bracket.\n', {
      rules: { 'unapproved-vocabulary': { severity: 'info' } },
    });
    expect(result.forRule('unapproved-vocabulary')[0]?.severity).toBe('info');
  });

  it('invalid rule options skip the rule and produce a notice instead of throwing', () => {
    const resolved = resolveConfig({
      rules: { 'sentence-length-procedural': { maxGradeLevel: -5 } },
    });
    const doc = analyseDocument({ id: 't', format: 'markdown', text: 'Remove it.\n' });
    const result = runDeterministicRules({
      doc,
      rules: deterministicRules,
      config: resolved,
      pack: provisionalRulePack,
    });
    expect(result.notices.some((n) => n.code === 'rule-options-invalid')).toBe(true);
  });

  it('output ordering is stable across runs', () => {
    const text = "Prior to the test, don't utilise the the old bracket; stop now!\n";
    const a = run(text).diagnostics.map((d) => `${d.range.start}:${d.ruleId}`);
    const b = run(text).diagnostics.map((d) => `${d.range.start}:${d.ruleId}`);
    expect(a).toEqual(b);
    expect(a).toEqual(a.toSorted((x, y) => Number(x.split(':')[0]) - Number(y.split(':')[0])));
  });

  it('every diagnostic range points at exactly the flagged substring, not a shifted one', () => {
    // A `>0`-length check alone is satisfied even by a range shifted by a fixed offset (wrong
    // start/end, but still non-empty), so this asserts the sliced text equals the exact expected
    // substring for every diagnostic the sentence produces.
    const text = "Prior to installation, don't utilise the the old bracket; stop now!\n";
    expect(run(text).diagnostics.map((d) => text.slice(d.range.start, d.range.end))).toEqual([
      'Prior to',
      "don't",
      'utilise',
      'the the',
      ';',
      '!',
    ]);
  });

  it('every shipped rule declares provisional status', () => {
    expect(deterministicRules.every((r) => r.meta.status === 'provisional')).toBe(true);
  });

  it('every shipped rule accepts an empty options object', () => {
    for (const rule of deterministicRules) {
      expect(rule.optionsSchema.safeParse({}).success, rule.meta.id).toBe(true);
    }
  });

  it('rule ids are unique', () => {
    const ids = deterministicRules.map((r) => r.meta.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('plain-text documents', () => {
  it('analyses plain text without markdown structure rules', () => {
    const result = run('Utilise the bracket.\n\nDo not touch the busbar.\n', {}, 'text');
    expect(result.quotesFor('unapproved-vocabulary')).toEqual(['Utilise']);
  });
});
