import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import { analyseTextDeterministic } from '../../src/analysis/analyse.js';
import { semanticConfigSchema, type SteAiConfigInput } from '../../src/core/config.js';
import type { CandidatePassage, SemanticEvaluatorId } from '../../src/core/types.js';
import { buildEvaluatorRequest, evaluatorDefinitions } from '../../src/semantic/evaluators.js';
import { FilePromptProvider, formatValue } from '../../src/semantic/prompt-loader.js';

/**
 * `test/unit/prompt-corpus.test.ts` checks the declared contract: `payloadKeys` against what the
 * template consumes. It never checks that a real deterministic rule actually produces a candidate
 * satisfying that declaration — every candidate it renders is a hand-built fixture from
 * `test/helpers/evaluator-payloads.ts`.
 *
 * That gap hid a real defect: `passive-voice-adjudication` declared `mode` as a payload key, but
 * `pushCandidate` (`src/deterministic/rules/candidate-rules.ts`) only ever set it as a top-level
 * `CandidatePassage.mode` field. Every real request rendered `Passage classification from the
 * deterministic pass: none`, because `candidate.payload.mode` was always `undefined` — the hand-built
 * fixture masked this by setting `mode` in both places. Fixed in `src/semantic/evaluators.ts` by
 * resolving `mode` as a shared candidate-level variable, the same way `ruleId`, `passage` and
 * `invariants` already are.
 *
 * This file closes the gap that let it through: it drives real trigger documents through
 * `analyseTextDeterministic`, takes the actual `CandidatePassage` a deterministic rule produced, and
 * confirms every variable the evaluator's prompt template consumes resolves to a real value on that
 * candidate — not `formatValue`'s `undefined` -> `"none"` fallback standing in for data nobody wired
 * through.
 */

const config = semanticConfigSchema.parse({ enabled: true, model: 'test-model' });
const provider = new FilePromptProvider();

interface Trigger {
  readonly text: string;
  /** Per-rule config overrides beyond `semantic.enabled`, when a rule needs one to adjudicate. */
  readonly rules?: SteAiConfigInput['rules'];
}

/**
 * One document per evaluator that has a deterministic rule producing its candidate, each verified
 * to actually produce a candidate (not just a diagnostic) before being added here. An evaluator
 * with no producing rule cannot be exercised this way and is not listed -- see the `KNOWN_GAPS`
 * note below.
 *
 * `one-instruction-per-sentence` only reaches its candidate path for the ambiguous comma-joined
 * case (`src/deterministic/rules/structure-rules.ts`); a clear "and"-joined instruction is decided
 * deterministically and never produces a candidate at all. `approved-word-sense`'s only producer
 * gates on `adjudicateSense`, which defaults to `false` and is not implied by `semantic.enabled`.
 */
const TRIGGER_DOCUMENTS: Partial<Record<SemanticEvaluatorId, Trigger>> = {
  'passive-voice-adjudication': { text: 'The valve was closed by the technician.' },
  'noun-cluster-comprehension': {
    text: 'Check the engine oil pressure warning lamp test procedure.',
  },
  'pronoun-antecedent-ambiguity': {
    text: 'Connect the sensor to the controller. It must be earthed.',
  },
  'one-instruction-per-sentence': { text: 'Remove the cover, install the new filter.' },
  'approved-word-sense': {
    text: 'Utilise the torque wrench on each of the four bolts.',
    rules: { 'unapproved-vocabulary': { adjudicateSense: true } },
  },
};

const RULES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'deterministic',
  'rules',
);

/**
 * Every `evaluatorId` a deterministic rule actually assigns, derived from
 * `src/deterministic/rules/*.ts` source text rather than hand-maintained.
 *
 * A first fix here added `NO_DETERMINISTIC_PRODUCER`, a hand-maintained set of evaluators
 * confirmed (by the same grep this function's predecessor ran) to have no producer. Review found
 * that only caught a brand-new evaluator missing from both lists: an *existing* exemption, such as
 * `technical-term-legitimacy`, stayed silently exempt even after a producer was added for it,
 * because the exemption itself was never re-checked against source.
 *
 * A second fix derived the set from source with a regex matching only a literal-valued
 * `evaluatorId: '...'`. Review found that misses an aliased assignment: `CandidateRuleSpec
 * .evaluatorId` is typed as `SemanticEvaluatorId`, not required to be a literal, so `const
 * evaluator: SemanticEvaluatorId = 'technical-term-legitimacy'` followed by `evaluatorId:
 * evaluator` type-checks today and that regex silently missed it -- the same class of gap the
 * first fix left open, one indirection deeper.
 *
 * A real AST would resolve this cleanly, and was tried first: this repository pins `typescript`
 * at `^7.0.2`, the native rewrite, which does not ship the classic Compiler API this needs --
 * confirmed directly, `Object.keys(require('typescript'))` returns only `['version',
 * 'versionMajorMinor']`, no `createSourceFile`, no parser at all. No other AST-capable package is
 * a project dependency (`@oxc-project/types` and `@oxc-project/runtime` ship type declarations and
 * a runtime helper, not a callable parser). Adding one just for this single test file was judged
 * disproportionate to the gap it closes.
 *
 * This matches every `evaluatorId:` property assignment's full right-hand side up to its
 * terminating comma or line end, then resolves that captured text three ways: directly, when it is
 * a single-quoted string literal; through a same-file top-level `const NAME = 'literal';`
 * declaration, when it is a bare identifier; or recognised and skipped, for the one genuine
 * pass-through this codebase has -- `pushCandidate` in `candidate-rules.ts` forwards
 * `spec.evaluatorId` into the `CandidatePassage` it returns, which is not a second producer
 * declaration, only the first one's value reaching a different object literal. Anything else
 * throws immediately, naming the file and the unresolved text, rather than silently resolving to
 * nothing the way the first two fixes both did in their own way -- so a syntax form this function
 * does not yet understand fails the test loudly instead of quietly under-counting the producer set.
 *
 * A third fix added a second pass for object-literal shorthand (`{ ...base, evaluatorId, payload }`)
 * -- review found the colon-anchored pattern above does not merely mis-resolve that form, it never
 * matches it at all, so a producer written that way stayed silently absent from the derived set
 * with no throw. The second pass finds every bare `evaluatorId` identifier the first pass's
 * resolutions do not already account for and resolves or throws the same way.
 */
function derivedProducerIds(): ReadonlySet<SemanticEvaluatorId> {
  // Maps each declared id to itself so a resolved string can be typed as SemanticEvaluatorId
  // without an unsafe assertion: the value returned by a successful lookup is already that type.
  const declared = new Map<string, SemanticEvaluatorId>(
    evaluatorDefinitions.map((d) => [d.id, d.id]),
  );
  const ids = new Set<SemanticEvaluatorId>();

  for (const entry of readdirSync(RULES_DIR)) {
    if (!entry.endsWith('.ts')) continue;
    const text = readFileSync(join(RULES_DIR, entry), 'utf8');

    // Every top-level `const NAME = 'literal';` in this file, for resolving a same-file identifier
    // alias back to the string it names. Anchored to column 0 so a nested `const` inside a
    // function body -- a genuinely different binding -- is not treated as this file's alias table.
    const topLevelStringConsts = new Map<string, string>();
    for (const match of text.matchAll(/^const (\w+)(?::\s*\w+)?\s*=\s*'([^']*)'/gm)) {
      const [, name, value] = match;
      if (name !== undefined && value !== undefined) topLevelStringConsts.set(name, value);
    }

    for (const match of text.matchAll(/evaluatorId:\s*([^,;\n]+?)\s*(,|;)?\s*$/gm)) {
      const rhs = match[1];
      const terminator = match[2];
      if (rhs === undefined) continue;
      // A semicolon terminator means this is a type-member declaration (like
      // `CandidateRuleSpec`'s own `readonly evaluatorId: SemanticEvaluatorId;`), not a value
      // assignment -- nothing to resolve, since no producer is declared here.
      if (terminator === ';') continue;
      const literalMatch = /^'([^']*)'$/.exec(rhs);
      if (literalMatch?.[1] !== undefined) {
        const known = declared.get(literalMatch[1]);
        if (known !== undefined) ids.add(known);
        continue;
      }
      const identifierMatch = /^(\w+)$/.exec(rhs);
      if (identifierMatch?.[1] !== undefined) {
        const alias = topLevelStringConsts.get(identifierMatch[1]);
        if (alias === undefined) {
          throw new Error(
            `${entry}: an "evaluatorId" property is assigned from identifier "${identifierMatch[1]}", ` +
              'which is not a same-file top-level string const this test can resolve -- extend ' +
              'derivedProducerIds() to handle this form, or use a literal or a top-level const.',
          );
        }
        const known = declared.get(alias);
        if (known !== undefined) ids.add(known);
        continue;
      }
      if (/^\w+\.evaluatorId$/.test(rhs)) continue; // the known `spec.evaluatorId` pass-through
      throw new Error(
        `${entry}: an "evaluatorId" property has a value this test cannot statically resolve to ` +
          `a string ("${rhs}") -- extend derivedProducerIds() to handle this form.`,
      );
    }

    // Object-literal shorthand (`{ ...base, evaluatorId, payload }`) never matches the pattern
    // above at all -- there is no colon for it to match against -- so it would otherwise leave a
    // real producer silently out of `ids` rather than resolving or throwing. This finds every bare
    // `evaluatorId` identifier sitting in shorthand-property position: immediately preceded by `{`
    // or `,` and immediately followed by `,` or `}` (each allowing surrounding whitespace, so a
    // multi-line object literal still matches). That position requirement is deliberately narrow --
    // review found an earlier version matched *any* bare "evaluatorId" token, including a comment,
    // a function parameter's name, or an unrelated top-level declaration, none of which declare a
    // producer -- so this only matches genuine object-literal shorthand syntax.
    for (const _ of text.matchAll(/(?<=[{,]\s*)evaluatorId(?=\s*[,}])/g)) {
      const alias = topLevelStringConsts.get('evaluatorId');
      if (alias === undefined) {
        throw new Error(
          `${entry}: found a shorthand "evaluatorId" property (no colon) this test cannot ` +
            'statically resolve unless a top-level "const evaluatorId = \'...\';" exists in the ' +
            'same file -- extend derivedProducerIds() to handle this form.',
        );
      }
      const known = declared.get(alias);
      if (known !== undefined) ids.add(known);
    }
  }

  return ids;
}

/**
 * Evaluator variables allowed to resolve from missing data today, each tracked by an open issue
 * rather than silently permitted. A gap landing here without a citation is a regression this test
 * must still catch -- only a cited, already-known gap belongs on this list.
 *
 * `approved-word-sense`'s only real producer (`src/deterministic/rules/vocabulary.ts`, the
 * unapproved-vocabulary path) never populates `permittedSenses`: nothing in `src/` reads the rule
 * pack's `senses` field at all, so the sense-adjudication feature the schema, prompt and evaluator
 * all support has no working trigger yet. See
 * https://github.com/Jamie-BitFlight/textlint-rule-preset-ste-ai/issues/111.
 */
const KNOWN_GAPS: ReadonlySet<string> = new Set(['approved-word-sense.permittedSenses']);

function candidatesFor(evaluatorId: SemanticEvaluatorId, trigger: Trigger): CandidatePassage[] {
  const result = analyseTextDeterministic(trigger.text, {
    config: {
      semantic: { enabled: true, model: 'test-model' },
      ...(trigger.rules === undefined ? {} : { rules: trigger.rules }),
    },
  });
  return result.candidates.filter((c) => c.evaluatorId === evaluatorId);
}

describe('real candidates satisfy their evaluator payload contract', () => {
  const derivedProducers = derivedProducerIds();
  const covered = evaluatorDefinitions
    .map((d) => d.id)
    .filter((id) => TRIGGER_DOCUMENTS[id] !== undefined);

  it('finds at least one evaluatorId assignment in the rules source, so derivation is not vacuous', () => {
    expect(derivedProducers.size).toBeGreaterThan(0);
  });

  it('has a trigger document for exactly the evaluators src/deterministic/rules assigns', () => {
    // Fails loudly whichever way the two sets diverge: a new producer added without a trigger
    // document, or an existing trigger document left behind after its rule stopped assigning that
    // evaluatorId -- both are the same "TRIGGER_DOCUMENTS no longer matches source" defect.
    const triggerIds = Object.keys(TRIGGER_DOCUMENTS).toSorted();
    expect(triggerIds).toEqual([...derivedProducers].toSorted());
  });

  it('covers every evaluator that has a deterministic producer', () => {
    for (const definition of evaluatorDefinitions) {
      const trigger = TRIGGER_DOCUMENTS[definition.id];
      // 1 stands in for "not applicable" when there is no trigger to run -- the sibling test above
      // already fails when a derived producer has no trigger document, and this expect must stay
      // unconditional regardless of that other test's outcome.
      const candidateCount =
        trigger === undefined ? 1 : candidatesFor(definition.id, trigger).length;
      expect(
        candidateCount,
        `${definition.id}: trigger document produced no candidate`,
      ).toBeGreaterThan(0);
    }
  });

  for (const evaluatorId of covered) {
    it(`${evaluatorId}: the rendered request carries the real candidate's own data`, () => {
      const trigger = TRIGGER_DOCUMENTS[evaluatorId];
      if (trigger === undefined) throw new Error('unreachable: covered only lists documented ids');
      const produced = candidatesFor(evaluatorId, trigger)[0];
      if (produced === undefined) throw new Error(`no candidate produced for ${evaluatorId}`);
      const candidate: CandidatePassage = produced;

      const template = provider.get(config.promptVersion, evaluatorId);

      // What each template variable *should* resolve to, read directly off the real candidate --
      // the same three shared fields plus `mode` that `buildEvaluatorRequest` special-cases, or the
      // payload otherwise. This does not call `buildEvaluatorRequest`; it is the independent source
      // of truth the rendered request is checked against below, so a bug in that function's own
      // resolution logic cannot hide by also being read here.
      function realValueFor(variable: string): unknown {
        if (variable === 'ruleId') return candidate.ruleId;
        if (variable === 'passage') return candidate.passage;
        if (variable === 'invariants') return candidate.invariants;
        if (variable === 'mode') return candidate.mode;
        return candidate.payload[variable];
      }

      for (const variable of template.variables) {
        const gapKey = `${evaluatorId}.${variable}`;
        const isKnownGap = KNOWN_GAPS.has(gapKey);
        const isDefined = realValueFor(variable) !== undefined;
        const message = isKnownGap
          ? `${gapKey} is listed as a known gap but now has real data -- remove it from KNOWN_GAPS`
          : `${gapKey}: real candidate has no value for {{${variable}}}`;
        expect(isDefined, message).toBe(!isKnownGap);
      }

      // The request the real pipeline would actually send. Checked against `realValueFor` above,
      // not against the fixtures `test/unit/prompts.test.ts` uses -- this is what would have caught
      // the `mode` defect: `candidate.payload.mode` was `undefined`, `candidate.mode` was
      // `'descriptive'`, and only rendering the request and checking for `'descriptive'` verbatim
      // catches a resolution path that reads the wrong one.
      const request = buildEvaluatorRequest(candidate, config, provider);
      const rendered = request.messages[1]?.content ?? '';
      for (const variable of template.variables) {
        const gapKey = `${evaluatorId}.${variable}`;
        if (KNOWN_GAPS.has(gapKey)) continue;
        const expected = formatValue(realValueFor(variable));
        expect(
          rendered,
          `${gapKey}: rendered request does not contain the real candidate's value for ` +
            `{{${variable}}} -- buildEvaluatorRequest resolved it from somewhere else`,
        ).toContain(expected);
      }
    });
  }
});
