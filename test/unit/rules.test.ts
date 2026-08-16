import { describe, expect, it } from 'vitest';
import { resolveConfig, type SteAiConfigInput } from '../../src/core/config.js';
import { analyseDocument } from '../../src/core/document.js';
import { runDeterministicRules } from '../../src/core/runner.js';
import type { Diagnostic, DocumentFormat } from '../../src/core/types.js';
import { deterministicRules } from '../../src/deterministic/index.js';
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

  it('counts a quantity as one word rather than dropping it', () => {
    const text = 'Torque each bolt to 25 Nm.\n';
    const doc = analyseDocument({ id: 't', format: 'markdown', text });
    expect(doc.sentences[0]?.words.map((w) => w.text)).toEqual([
      'Torque',
      'each',
      'bolt',
      'to',
      '25 Nm',
    ]);
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
    expect(run('Stop the pump; close the valve.\n').quotesFor(id)).toContain(';');
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
    expect(
      run('Stop the pump; close the valve.\n', {
        rules: { [id]: { forbidSemicolon: false } },
      }).quotesFor(id),
    ).not.toContain(';');
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
    expect(passive.length).toBeGreaterThan(0);
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
    expect(result.forRule('passive-voice-candidate').length).toBeGreaterThan(0);
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

  it('every diagnostic range points at real, non-empty source', () => {
    const text = "Prior to installation, don't utilise the the old bracket; stop now!\n";
    for (const d of run(text).diagnostics) {
      expect(text.slice(d.range.start, d.range.end).length).toBeGreaterThan(0);
    }
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
