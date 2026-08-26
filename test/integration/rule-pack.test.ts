import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { analyseTextDeterministic } from '../../src/analysis/analyse.js';
import { packPermitsConformanceClaim, parseRulePack } from '../../src/rule-pack/loader.js';

/**
 * The rule pack is this package's only extension point, and until this file existed it had no test
 * coverage at all: nothing in `test/` referenced `rulePack`, `trustedRulePackIds`,
 * `verifiedAuthority` or `packPermitsConformanceClaim`. Its entire specification lived as prose in
 * `docs/rule-pack-import.md`, `README.md` and a doc comment in `src/rule-pack/schema.ts`.
 *
 * Three of those four artefacts drifted from the code and from each other, and external review
 * found the drift one claim at a time across three rounds of PR #90 — six findings, every one of
 * the form "the prose asserts X, the code does Y". Prose cannot fail a build, so each correction
 * was itself unverified and introduced the next inaccuracy.
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

describe('rule pack: the trust gate', () => {
  it('caps an untrusted pack at supplementary however it declares itself', () => {
    // Schema validation proves shape, never provenance: any JSON file can assert
    // `authority: "normative"`, so a pack cannot elevate itself.
    const diagnostic = only(VOCABULARY_DOC, { rulePack: pack() }, 'unapproved-vocabulary');

    expect(diagnostic.ruleStatus).toBe('supplementary');
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
