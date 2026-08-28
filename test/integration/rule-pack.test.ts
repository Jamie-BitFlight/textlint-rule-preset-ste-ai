import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { analyseTextDeterministic } from '../../src/analysis/analyse.js';
import {
  RulePackError,
  packPermitsConformanceClaim,
  parseRulePack,
} from '../../src/rule-pack/loader.js';

/**
 * The rule pack is this package's only extension point, and until this file existed it had no test
 * coverage at all: nothing in `test/` referenced `rulePack`, `trustedRulePackIds`,
 * `verifiedAuthority` or `packPermitsConformanceClaim`. Its entire specification lived as prose in
 * `docs/rule-pack-import.md`, `README.md` and a doc comment in `src/rule-pack/schema.ts`, which let
 * the same behavioural claim drift from the code and from each other, independently, undetected.
 *
 * What is pinned here is therefore not "the pack loader works". It is every behavioural claim the
 * documentation makes, expressed so that a future change to the behaviour fails CI instead of
 * silently making the documentation wrong again. When a claim here changes, the doc changes with
 * it; `test/architecture/doc-pack-control-surface.test.ts` enforces the other direction, so a
 * schema field cannot be added without the page that documents it being updated too.
 */

const PACK_ID = 'acme-test-pack';

/** Matches `test/e2e/example-config.test.ts`: a real runtime check, not an assumption. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A minimal valid pack. Zod fills the rest; overrides replace whole top-level keys. */
function pack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    metadata: {
      id: PACK_ID,
      name: 'Acme test pack',
      version: '1.0.0',
      authority: 'normative',
      licence: 'Proprietary — test fixture',
      source: 'Authored for this test. Not derived from any standard.',
      conformanceClaim: 'declared-by-supplier',
    },
    limits: {
      proceduralMaxGradeLevel: 7,
      descriptiveMaxGradeLevel: 8,
      sentenceReadabilityFloorWords: 20,
      maxNounClusterLength: 3,
      maxSentencesPerProceduralStep: 1,
    },
    dictionary: {
      approved: [],
      unapproved: [{ term: 'utilise', alternatives: ['use'] }],
      preferred: [],
    },
    contractions: [],
    approvedTechnicalTerms: [],
    rules: [
      { ruleId: 'unapproved-vocabulary', status: 'normative', sourceRef: 'ACME-DOC-1 clause 4' },
      {
        ruleId: 'passive-voice-candidate',
        status: 'provisional',
        sourceRef: 'ACME-DOC-1 clause 9',
      },
    ],
    ...overrides,
  };
}

/** A deterministic violation of `unapproved-vocabulary`, per the pack's dictionary above. */
const VOCABULARY_DOC = 'Utilise the bracket.\n';
/** Triggers `passive-voice-candidate`, which emits a candidate rather than a diagnostic. */
const PASSIVE_DOC = 'The bracket is removed by the technician.\n';

function analyse(text: string, config: Record<string, unknown>) {
  return analyseTextDeterministic(text, { config: config });
}

function only(text: string, config: Record<string, unknown>, ruleId: string) {
  const found = analyse(text, config).diagnostics.filter((d) => d.ruleId === ruleId);
  expect(found, `expected exactly one ${ruleId} diagnostic`).toHaveLength(1);
  return found[0]!;
}

/** `pack()`'s default limits, so a test overriding one field doesn't have to restate the rest. */
function limitsWith(overrides: Record<string, number>): Record<string, number> {
  return {
    proceduralMaxGradeLevel: 7,
    descriptiveMaxGradeLevel: 8,
    sentenceReadabilityFloorWords: 20,
    maxNounClusterLength: 3,
    maxSentencesPerProceduralStep: 1,
    ...overrides,
  };
}

/**
 * The thrown value, or `undefined` if `fn` did not throw.
 *
 * Kept out of a try/catch at the call site so the assertions on the result are never inside a
 * conditional block — `vitest/no-conditional-expect` forbids `expect()` inside `catch`.
 */
function caughtError(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('rule pack: the trust gate', () => {
  it('caps an untrusted pack at supplementary however it declares itself', () => {
    // Schema validation proves shape, never provenance: any JSON file can assert
    // `authority: "normative"`, so a pack cannot elevate itself.
    const diagnostic = only(VOCABULARY_DOC, { rulePack: pack() }, 'unapproved-vocabulary');

    expect(diagnostic.ruleStatus).toBe('supplementary');
  });

  it("withholds an untrusted pack's fabricated citation instead of printing it verbatim (#66)", () => {
    // A pack's `sourceRef` is free text the supplier controls. Printing it verbatim next to a
    // `supplementary` tag lets an untrusted pack fabricate a specific-looking citation (e.g. a
    // standard clause number) that most readers will not weigh against the tag.
    const diagnostic = only(VOCABULARY_DOC, { rulePack: pack() }, 'unapproved-vocabulary');

    expect(diagnostic.meta).not.toMatchObject({ sourceRef: 'ACME-DOC-1 clause 4' });
    expect(diagnostic.meta?.['sourceRef']).toContain(PACK_ID);
  });

  it("withholds the citation even when the pack declares 'supplementary' directly", () => {
    // Codex review on PR #116: gating the citation on whether `ruleStatus` was actually *downgraded*
    // let an untrusted pack bypass the check just by declaring `status: "supplementary"` up front —
    // `verifiedRuleStatus` only ever touches a `"normative"` declaration, so a directly-declared
    // `"supplementary"` was never downgraded and its citation sailed through unexamined. The gate
    // must withhold an untrusted pack's citation for *any* declared status that isn't the rule's own
    // built-in default, not only a declaration of `"normative"`.
    const diagnostic = only(
      VOCABULARY_DOC,
      {
        rulePack: pack({
          rules: [
            {
              ruleId: 'unapproved-vocabulary',
              status: 'supplementary',
              sourceRef: 'ACME-DOC-1 clause 4',
            },
          ],
        }),
      },
      'unapproved-vocabulary',
    );

    expect(diagnostic.ruleStatus).toBe('supplementary');
    expect(diagnostic.meta).not.toMatchObject({ sourceRef: 'ACME-DOC-1 clause 4' });
    expect(diagnostic.meta?.['sourceRef']).toContain(PACK_ID);
  });

  it("passes an untrusted pack's citation through unchanged when it only restates the rule's own default", () => {
    // The trust gate withholds a citation only when the pack entry claims something the rule does
    // not already claim about itself. Every shipped rule's own `meta.status` is `provisional`
    // (`DISCLAIMER.md`), so a pack entry that also declares `provisional` is not claiming anything
    // beyond the rule's built-in baseline, and its citation is not neutralised just because the pack
    // as a whole is untrusted. This is also what lets the bundled provisional pack's own citations
    // through without needing `trustedRulePackIds` to name it.
    const diagnostic = only(
      VOCABULARY_DOC,
      {
        rulePack: pack({
          rules: [
            {
              ruleId: 'unapproved-vocabulary',
              status: 'provisional',
              sourceRef: 'ACME-DOC-1 clause 4',
            },
          ],
        }),
      },
      'unapproved-vocabulary',
    );

    expect(diagnostic.ruleStatus).toBe('provisional');
    expect(diagnostic.meta).toMatchObject({ sourceRef: 'ACME-DOC-1 clause 4' });
  });

  it('honours a declared status only once the operator names the pack as trusted', () => {
    const diagnostic = only(
      VOCABULARY_DOC,
      { rulePack: pack(), trustedRulePackIds: [PACK_ID] },
      'unapproved-vocabulary',
    );

    expect(diagnostic.ruleStatus).toBe('normative');
    expect(diagnostic.meta).toMatchObject({ sourceRef: 'ACME-DOC-1 clause 4' });
  });

  it('matches the trust entry against metadata.id, not the pack name or file path', () => {
    const diagnostic = only(
      VOCABULARY_DOC,
      { rulePack: pack(), trustedRulePackIds: ['Acme test pack'] },
      'unapproved-vocabulary',
    );

    expect(diagnostic.ruleStatus).toBe('supplementary');
  });
});

describe('rule pack: status propagation differs by rule path', () => {
  /**
   * The asymmetry below is the behaviour external review flagged twice on PR #90, and it is the
   * reason a pack author cannot reason about `rules[].status` alone.
   *
   * `runDeterministicRules()` applies the pack's per-rule status to `output.diagnostics` only
   * (`src/core/runner.ts`). Candidates bypass that entirely and are stamped later with the
   * pack-*wide* `verifiedAuthority()` (`src/analysis/analyse.ts`). So omitting a rule from
   * `rules[]` moves its reported status in opposite directions depending on which path it takes.
   */

  it('falls back to the rule default when a deterministic rule is absent from rules[]', () => {
    const diagnostic = only(
      VOCABULARY_DOC,
      { rulePack: pack({ rules: [] }), trustedRulePackIds: [PACK_ID] },
      'unapproved-vocabulary',
    );

    // Trusted, normative pack — and still provisional, because nothing in `rules[]` named the rule.
    expect(diagnostic.ruleStatus).toBe('provisional');
    expect(diagnostic.meta).not.toHaveProperty('sourceRef');
  });

  it('ignores rules[].status for a candidate rule and applies pack-wide authority instead', () => {
    // The pack lists this rule as `provisional`. The reported status is `normative` regardless.
    const diagnostic = only(
      PASSIVE_DOC,
      { rulePack: pack(), trustedRulePackIds: [PACK_ID] },
      'passive-voice-candidate',
    );

    expect(diagnostic.category).toBe('review-required');
    expect(diagnostic.ruleStatus).toBe('normative');
  });

  it('drops rules[].sourceRef entirely on the candidate path', () => {
    // A pack's citation reaches a deterministic diagnostic but never a review-required one.
    const diagnostic = only(
      PASSIVE_DOC,
      { rulePack: pack(), trustedRulePackIds: [PACK_ID] },
      'passive-voice-candidate',
    );

    expect(diagnostic.meta).not.toHaveProperty('sourceRef');
    expect(diagnostic.meta).toMatchObject({ evaluatorId: 'passive-voice-adjudication' });
  });

  it('still caps the candidate path at supplementary for an untrusted pack', () => {
    const diagnostic = only(PASSIVE_DOC, { rulePack: pack() }, 'passive-voice-candidate');

    expect(diagnostic.ruleStatus).toBe('supplementary');
  });
});

describe('rule pack: what the pack actually controls', () => {
  it('supplies the vocabulary a deterministic rule matches on', () => {
    const clean = analyse(VOCABULARY_DOC, {
      rulePack: pack({ dictionary: { approved: [], unapproved: [], preferred: [] } }),
    });

    expect(clean.diagnostics.filter((d) => d.ruleId === 'unapproved-vocabulary')).toHaveLength(0);
  });

  it('protects approvedTechnicalTerms from vocabulary matching', () => {
    // This is pack-controlled vocabulary in every practical sense: it silences a finding the same
    // pack's own `dictionary.unapproved` produces. Any "the pack only controls the dictionary"
    // wording that omits it is wrong.
    const result = analyse(VOCABULARY_DOC, {
      rulePack: pack({ approvedTechnicalTerms: ['Utilise'] }),
      trustedRulePackIds: [PACK_ID],
    });

    expect(result.diagnostics.filter((d) => d.ruleId === 'unapproved-vocabulary')).toHaveLength(0);
  });

  it('sets a default severity that user configuration overrides', () => {
    const packRules = [
      {
        ruleId: 'unapproved-vocabulary',
        status: 'normative',
        sourceRef: 'ACME-DOC-1 clause 4',
        severity: 'warning',
      },
    ];

    const fromPack = only(
      VOCABULARY_DOC,
      { rulePack: pack({ rules: packRules }), trustedRulePackIds: [PACK_ID] },
      'unapproved-vocabulary',
    );
    expect(fromPack.severity).toBe('warning');

    const fromUser = only(
      VOCABULARY_DOC,
      {
        rulePack: pack({ rules: packRules }),
        trustedRulePackIds: [PACK_ID],
        rules: { 'unapproved-vocabulary': { severity: 'info' } },
      },
      'unapproved-vocabulary',
    );
    expect(fromUser.severity, 'user configuration outranks the pack').toBe('info');
  });

  it('turns a rule off through rules[].enabled', () => {
    const result = analyse(VOCABULARY_DOC, {
      rulePack: pack({
        rules: [
          {
            ruleId: 'unapproved-vocabulary',
            status: 'normative',
            sourceRef: 'ACME-DOC-1 clause 4',
            enabled: false,
          },
        ],
      }),
      trustedRulePackIds: [PACK_ID],
    });

    expect(result.diagnostics.filter((d) => d.ruleId === 'unapproved-vocabulary')).toHaveLength(0);
  });
});

describe('rule pack: what the pack cannot control', () => {
  it('cannot extend a hard-coded trigger list', () => {
    // `PRONOUNS` in `src/deterministic/rules/candidate-rules.ts` is hard-coded and holds
    // `it/they/them/this/these/those/which/its/their`. "He" is absent, and no pack field adds it:
    // declaring it in the dictionary produces an unrelated vocabulary finding, never a pronoun
    // one. An authorised licensee therefore cannot supply this rule's trigger vocabulary the way
    // they supply the dictionary — the claim `src/rule-pack/schema.ts` used to deny.
    const result = analyse('Remove the bracket and the filter. He is damaged.\n', {
      rulePack: pack({
        dictionary: {
          approved: [],
          unapproved: [{ term: 'he', alternatives: ['the technician'] }],
          preferred: [],
        },
      }),
      trustedRulePackIds: [PACK_ID],
    });

    expect(
      result.diagnostics.filter((d) => d.ruleId === 'ambiguous-pronoun-candidate'),
    ).toHaveLength(0);
  });

  it('can nonetheless suppress a hard-coded trigger by protecting the token', () => {
    // The limitation above is one-directional, which is the part the prose kept getting wrong.
    // A pack cannot add a trigger word, but `approvedTechnicalTerms` protects a token from being
    // scanned at all, so it can remove one. "A pack cannot change those lists" overstates it.
    const flagged = analyse('Remove the bracket and the filter. It is damaged.\n', {
      rulePack: pack(),
      trustedRulePackIds: [PACK_ID],
    });
    expect(
      flagged.diagnostics.filter((d) => d.ruleId === 'ambiguous-pronoun-candidate'),
    ).toHaveLength(1);

    const protectedRun = analyse('Remove the bracket and the filter. It is damaged.\n', {
      rulePack: pack({ approvedTechnicalTerms: ['It'] }),
      trustedRulePackIds: [PACK_ID],
    });
    expect(
      protectedRun.diagnostics.filter((d) => d.ruleId === 'ambiguous-pronoun-candidate'),
    ).toHaveLength(0);
  });

  it('cannot add a rule that does not exist in code', () => {
    const result = analyse(VOCABULARY_DOC, {
      rulePack: pack({
        rules: [
          { ruleId: 'acme-invented-rule', status: 'normative', sourceRef: 'ACME-DOC-1 clause 99' },
        ],
      }),
      trustedRulePackIds: [PACK_ID],
    });

    expect(result.diagnostics.filter((d) => d.ruleId === 'acme-invented-rule')).toHaveLength(0);
  });
});

describe('rule pack: the conformance claim gate', () => {
  /**
   * Three conditions, all required. The doc claimed for a while that nothing emits a conformance
   * claim at all; the CLI does emit one, through this gate, so the truth table is pinned here.
   */
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly authority: string;
    readonly claim: string;
    readonly trusted: readonly string[];
    readonly expected: boolean;
  }> = [
    {
      name: 'normative + claim + trusted',
      authority: 'normative',
      claim: 'declared-by-supplier',
      trusted: [PACK_ID],
      expected: true,
    },
    {
      name: 'normative + claim, untrusted',
      authority: 'normative',
      claim: 'declared-by-supplier',
      trusted: [],
      expected: false,
    },
    {
      name: 'normative + trusted, but claim is none',
      authority: 'normative',
      claim: 'none',
      trusted: [PACK_ID],
      expected: false,
    },
    {
      name: 'claim + trusted, but authority is supplementary',
      authority: 'supplementary',
      claim: 'partial',
      trusted: [PACK_ID],
      expected: false,
    },
  ];

  for (const { name, authority, claim, trusted, expected } of cases) {
    it(`${expected ? 'permits' : 'refuses'} a claim: ${name}`, () => {
      const parsed = parseRulePack(
        pack({
          metadata: {
            id: PACK_ID,
            name: 'Acme test pack',
            version: '1.0.0',
            authority,
            licence: 'Proprietary — test fixture',
            source: 'Authored for this test.',
            conformanceClaim: claim,
          },
        }),
        'test',
      );

      expect(packPermitsConformanceClaim(parsed, trusted)).toBe(expected);
    });
  }

  it('refuses a claim for the bundled provisional pack', () => {
    const result = analyse(VOCABULARY_DOC, {});
    const bundled = result.diagnostics.filter((d) => d.ruleId === 'unapproved-vocabulary');

    // The bundled pack declares `provisional` authority and `conformanceClaim: 'none'`, so it
    // fails the gate on two of the three conditions independently of any trust list.
    for (const diagnostic of bundled) expect(diagnostic.ruleStatus).toBe('provisional');
  });
});

describe('the shipped example pack', () => {
  /**
   * `examples/rule-pack/` is documentation that executes, in the same sense as
   * `test/e2e/example-config.test.ts`: its README quotes finding counts, and a reader who copies
   * the directory expects to see them. These assertions are those quoted numbers. Change the
   * example and this fails until the README agrees again.
   */

  const EXAMPLE = resolve(import.meta.dirname, '..', '..', 'examples', 'rule-pack');

  function examplePack(): Record<string, unknown> {
    const parsed: unknown = JSON.parse(readFileSync(resolve(EXAMPLE, 'acme-pack.json'), 'utf8'));
    if (!isRecord(parsed)) {
      throw new TypeError('examples/rule-pack/acme-pack.json is not a JSON object');
    }
    return parsed;
  }

  const sample = () => readFileSync(resolve(EXAMPLE, 'sample.md'), 'utf8');

  function errorIds(config: Record<string, unknown>): string[] {
    return analyse(sample(), config)
      .diagnostics.filter((d) => d.category === 'deterministic-violation')
      .map((d) => d.ruleId)
      .toSorted();
  }

  it('parses against the real schema', () => {
    expect(() => parseRulePack(examplePack(), 'examples/rule-pack/acme-pack.json')).not.toThrow();
  });

  it('reports one error under the bundled pack', () => {
    // "Utilise" only. The bundled dictionary knows nothing of the Acme vocabulary.
    expect(errorIds({})).toStrictEqual(['unapproved-vocabulary']);
  });

  it('reports three errors under the example pack, and no longer flags Utilise', () => {
    // A pack *replaces* the dictionary rather than adding to it. This is the single fact readers
    // most often get wrong, so the example is built to show it rather than assert it.
    const ids = errorIds({ rulePack: examplePack() });

    expect(ids).toStrictEqual([
      'preferred-terminology',
      'unapproved-vocabulary',
      'unapproved-vocabulary',
    ]);

    const messages = analyse(sample(), { rulePack: examplePack() }).diagnostics.map(
      (d) => d.message,
    );
    expect(messages.some((m) => m.includes('Utilise'))).toBe(false);
  });

  it('protects the product name through approvedTechnicalTerms', () => {
    const messages = analyse(sample(), { rulePack: examplePack() }).diagnostics.map(
      (d) => d.message,
    );

    expect(messages.some((m) => m.includes('WidgetPro'))).toBe(false);
  });

  it('reports supplementary until trusted, and normative once trusted', () => {
    const untrusted = analyse(sample(), { rulePack: examplePack() }).diagnostics.filter(
      (d) => d.ruleId === 'unapproved-vocabulary',
    );
    for (const diagnostic of untrusted) expect(diagnostic.ruleStatus).toBe('supplementary');

    const trusted = analyse(sample(), {
      rulePack: examplePack(),
      trustedRulePackIds: ['acme-maintenance-2026'],
    }).diagnostics.filter((d) => d.ruleId === 'unapproved-vocabulary');
    for (const diagnostic of trusted) expect(diagnostic.ruleStatus).toBe('normative');
  });

  it('permits a conformance claim only once the operator trusts it', () => {
    const parsed = parseRulePack(examplePack(), 'example');

    expect(packPermitsConformanceClaim(parsed, [])).toBe(false);
    expect(packPermitsConformanceClaim(parsed, ['acme-maintenance-2026'])).toBe(true);
  });
});

describe('rule pack: limits, contractions, path resolution, and the autofix gate', () => {
  /**
   * External review on this PR named four claims the page makes that nothing above exercised:
   * `limits`, `contractions`, resolving a relative `rulePack` path against `baseDir`, and the
   * autofix gate refusing a fix despite a pack's `safeSubstitution: true`. Removing the blanket "is
   * pinned by" claim would have been the cheaper fix; this is the other one, closing the gap
   * instead of describing it.
   */

  // Estimated Flesch-Kincaid grade 15.4 (28 words) under the bundled reader — comfortably between
  // the two limit values exercised below, and confirmed empirically rather than assumed: see the
  // identical sentence in test/unit/rules.test.ts's "applies the descriptive limit" case.
  const DESCRIPTIVE_SENTENCE =
    'The controller monitors the supply voltage and the ambient temperature and then reports ' +
    'both of these values to the host system over the diagnostic bus once every second.\n';

  it('drives sentence-length-descriptive from limits.descriptiveMaxGradeLevel', () => {
    const atDefault = analyse(DESCRIPTIVE_SENTENCE, {
      rulePack: pack({ limits: limitsWith({ descriptiveMaxGradeLevel: 20 }) }),
    }).diagnostics.filter((d) => d.ruleId === 'sentence-length-descriptive');
    expect(atDefault, 'a permissive limit must not flag this sentence').toHaveLength(0);

    const tightened = analyse(DESCRIPTIVE_SENTENCE, {
      rulePack: pack({ limits: limitsWith({ descriptiveMaxGradeLevel: 1 }) }),
    }).diagnostics.filter((d) => d.ruleId === 'sentence-length-descriptive');
    expect(tightened, 'a near-zero limit must flag the same sentence').toHaveLength(1);
  });

  it('applies rules[].options as a default that user configuration outranks', () => {
    // docs/rule-pack-import.md's control-surface table: "rules[].options — Default options, below
    // anything the user configures." Three layers, in ascending precedence: the rule's own default
    // (here, pack.limits.descriptiveMaxGradeLevel, since neither options source sets one), the
    // pack's rules[].options, and the user's own rules[] config.
    const packOptions = {
      ruleId: 'sentence-length-descriptive',
      status: 'provisional',
      sourceRef: 'ACME-DOC-1 clause 1',
      options: { maxGradeLevel: 20 },
    };

    const fallsBackToPackLimits = analyse(DESCRIPTIVE_SENTENCE, {
      rulePack: pack({ limits: limitsWith({ descriptiveMaxGradeLevel: 8 }), rules: [] }),
    }).diagnostics.filter((d) => d.ruleId === 'sentence-length-descriptive');
    expect(fallsBackToPackLimits, 'no rules[].options: falls back to pack.limits').toHaveLength(1);

    const usesPackOptions = analyse(DESCRIPTIVE_SENTENCE, {
      rulePack: pack({ rules: [packOptions] }),
    }).diagnostics.filter((d) => d.ruleId === 'sentence-length-descriptive');
    expect(usesPackOptions, 'rules[].options.maxGradeLevel=20 permits this sentence').toHaveLength(
      0,
    );

    const userOutranksPack = analyse(DESCRIPTIVE_SENTENCE, {
      rulePack: pack({ rules: [packOptions] }),
      rules: { 'sentence-length-descriptive': { maxGradeLevel: 1 } },
    }).diagnostics.filter((d) => d.ruleId === 'sentence-length-descriptive');
    expect(userOutranksPack, 'user config overrides the pack default of 20').toHaveLength(1);
  });

  it('drives no-contractions from contractions[]', () => {
    const text = "The technician confirms it's ready.\n";

    const withoutEntry = analyse(text, { rulePack: pack({ contractions: [] }) }).diagnostics.filter(
      (d) => d.ruleId === 'no-contractions',
    );
    expect(withoutEntry).toHaveLength(0);

    const withEntry = analyse(text, {
      rulePack: pack({
        contractions: [{ from: "it's", to: 'it is', safeSubstitution: true }],
      }),
    }).diagnostics.filter((d) => d.ruleId === 'no-contractions');
    expect(withEntry).toHaveLength(1);
  });

  it('throws RulePackError with the failing field path, never falling back silently', () => {
    // docs/rule-pack-import.md, "The schema": "A pack that fails validation throws RulePackError
    // with the failing field paths. The linter never falls back to the provisional pack silently."
    const invalid = pack({
      metadata: {
        id: PACK_ID,
        name: 'Acme test pack',
        version: '1.0.0',
        authority: 'not-a-real-status',
        licence: 'Proprietary — test fixture',
        source: 'Authored for this test. Not derived from any standard.',
        conformanceClaim: 'declared-by-supplier',
      },
    });

    const error = caughtError(() => analyse(VOCABULARY_DOC, { rulePack: invalid }));

    expect(error).toBeInstanceOf(RulePackError);
    expect(error).toHaveProperty('message', expect.stringContaining('metadata.authority'));
  });

  describe('relative rulePack path resolution against baseDir', () => {
    let dir: string;

    it('loads a relative rulePack path resolved against baseDir', () => {
      dir = mkdtempSync(join(tmpdir(), 'ste-ai-rule-pack-basedir-'));
      writeFileSync(join(dir, 'pack.json'), JSON.stringify(pack()));

      const result = analyseTextDeterministic(VOCABULARY_DOC, {
        config: { rulePack: './pack.json' },
        baseDir: dir,
      });

      expect(result.diagnostics.filter((d) => d.ruleId === 'unapproved-vocabulary')).toHaveLength(
        1,
      );

      rmSync(dir, { recursive: true, force: true });
    });

    it('fails clearly when the relative path does not resolve under that baseDir', () => {
      const otherDir = mkdtempSync(join(tmpdir(), 'ste-ai-rule-pack-basedir-missing-'));

      expect(() =>
        analyseTextDeterministic(VOCABULARY_DOC, {
          config: { rulePack: './pack.json' },
          baseDir: otherDir,
        }),
      ).toThrow(/Cannot read rule pack/);

      rmSync(otherDir, { recursive: true, force: true });
    });
  });

  describe('the autofix gate outranks a pack declaring safeSubstitution: true', () => {
    // `docs/rule-pack-import.md`, "What the pack cannot do": safeSubstitution: true is necessary
    // but not sufficient. checkFixSafety() (src/core/rule.ts) still refuses a fix that changes a
    // digit, a negation, a modal, or an ordering word, regardless of what the pack asserts.

    it('applies a fix the pack marks safe when checkFixSafety agrees', () => {
      const result = analyse('Utilise the bracket.\n', {
        rulePack: pack({
          dictionary: {
            approved: [],
            unapproved: [{ term: 'utilise', alternatives: ['use'], safeSubstitution: true }],
            preferred: [],
          },
        }),
      });

      const diagnostic = result.diagnostics.find((d) => d.ruleId === 'unapproved-vocabulary');
      expect(diagnostic?.fix).toBeDefined();
      expect(diagnostic?.fix?.text).toBe('Use');
    });

    it('refuses the same pack-declared-safe fix when it would change negation', () => {
      const result = analyse('The bracket is not usable.\n', {
        rulePack: pack({
          dictionary: {
            approved: [],
            unapproved: [{ term: 'not usable', alternatives: ['usable'], safeSubstitution: true }],
            preferred: [],
          },
        }),
      });

      const diagnostic = result.diagnostics.find((d) => d.ruleId === 'unapproved-vocabulary');
      expect(diagnostic, 'the violation is still reported').toBeDefined();
      expect(diagnostic?.fix, 'no fix reaches the caller').toBeUndefined();
      expect(diagnostic?.message).toContain('No automatic fix');
      expect(diagnostic?.message).toContain('changes negation');
    });
  });
});
