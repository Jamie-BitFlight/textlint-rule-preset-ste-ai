import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
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
 * Four fixes preceded this one, each a hand-written text pattern closing the gap the last one
 * left open, and each review round finding the next gap the same way: a hand-maintained exemption
 * list that was never re-checked against source; a literal-only regex that missed an identifier
 * alias; a colon-anchored regex that never matched shorthand properties at all; a shorthand
 * detector that matched destructuring bindings and unrelated bare mentions of the word, not only
 * genuine object-literal shorthand. Each fix was real and individually correct, and each still
 * left a syntax shape a text pattern cannot soundly tell apart from a similar-looking one --
 * object-literal shorthand and destructuring shorthand read identically as text, and only differ
 * in which kind of node encloses them.
 *
 * A real AST closes that class of gap by construction rather than by enumeration, and was tried
 * first, before the first text-pattern fix: this repository's pinned `typescript` package does not
 * ship the classic Compiler API this needs -- no `createSourceFile`, no parser at all. The
 * `derivedProducerIds()'s AST approach is justified` test below pins that claim executably,
 * rather than as prose that goes stale the moment the pinned version changes; see it for the exact
 * check. `@babel/parser` was not a project dependency then either, but was already resolved in
 * `package-lock.json`, pulled in transitively by `magicast` (used by `vite-plus`'s own config
 * tooling). Declared as a direct devDependency now, pinned to the version already resolved, rather
 * than continuing to rely on an undeclared transitive one or patching another text-pattern edge
 * case.
 *
 * `walk` is a generic, visitor-key-agnostic AST walk: `@babel/traverse` is not available the same
 * way `@babel/parser` is, and a real traversal library is more machinery than this needs. It
 * recurses into every own property that looks like a node or an array of nodes, skipping metadata
 * fields, which needs no per-node-type knowledge and cannot silently miss a node shape.
 *
 * The lookup itself walks for `ObjectExpression` nodes -- genuine object value literals -- and
 * inspects only their own `.properties`, which is what makes an `ObjectPattern` (a destructuring
 * binding, from a function parameter or a `const { evaluatorId } = ...` declaration) categorically
 * unreachable: this never visits an `ObjectPattern`'s properties at all, not merely a check that
 * excludes them after finding them. Babel's own explicit `shorthand` flag on `ObjectProperty`
 * replaces the old position-based regex for shorthand detection.
 *
 * The `spec.evaluatorId` pass-through inside `pushCandidate` (`candidate-rules.ts`) is still the
 * one recognised exception -- forwarding an already-declared value into the `CandidatePassage`
 * `pushCandidate` returns, not a second producer declaration -- but review found the prior fix's
 * exemption matched any `X.evaluatorId` member expression, not only that one verified site. It is
 * now matched by name: only a `MemberExpression` whose object is exactly the identifier `spec` is
 * recognised: anything else -- a differently-named forwarding variable a future producer might
 * use -- falls through to the same throw as any other unresolvable form, naming the file and the
 * unresolved code, rather than being silently accepted as an equivalent pass-through it was never
 * verified to be.
 */
function isNode(value: unknown): value is t.Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

const AST_METADATA_KEYS: ReadonlySet<string> = new Set([
  'loc',
  'start',
  'end',
  'range',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'extra',
]);

function walk(node: t.Node, visit: (node: t.Node) => void): void {
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (AST_METADATA_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) walk(item, visit);
    } else if (isNode(value)) {
      walk(value, visit);
    }
  }
}

function derivedProducerIds(): ReadonlySet<SemanticEvaluatorId> {
  // Maps each declared id to itself so a resolved string can be typed as SemanticEvaluatorId
  // without an unsafe assertion: the value returned by a successful lookup is already that type.
  const declared = new Map<string, SemanticEvaluatorId>(
    evaluatorDefinitions.map((d) => [d.id, d.id]),
  );
  const ids = new Set<SemanticEvaluatorId>();

  for (const entry of readdirSync(RULES_DIR)) {
    if (!entry.endsWith('.ts')) continue;
    const filePath = join(RULES_DIR, entry);
    const text = readFileSync(filePath, 'utf8');
    const ast = parse(text, { sourceType: 'module', plugins: ['typescript'] });

    // Every top-level `const NAME = 'literal';` in this file, for resolving a same-file identifier
    // alias back to the string it names. Only `program.body` is scanned, not the full tree, so a
    // nested `const` inside a function body -- a genuinely different binding -- is not treated as
    // this file's alias table.
    const topLevelStringConsts = new Map<string, string>();
    for (const statement of ast.program.body) {
      if (!t.isVariableDeclaration(statement) || statement.kind !== 'const') continue;
      for (const decl of statement.declarations) {
        if (
          t.isIdentifier(decl.id) &&
          decl.init !== null &&
          decl.init !== undefined &&
          t.isStringLiteral(decl.init)
        ) {
          topLevelStringConsts.set(decl.id.name, decl.init.value);
        }
      }
    }

    // A literal that resolves to a string outside `declared` is not a form this test cannot
    // parse -- it parsed fine -- it is a producer naming an evaluator that does not exist. Review
    // found this silently discarded instead of failing: `declared.get(...)` returning `undefined`
    // just skipped the `ids.add`, so a typo'd or not-yet-declared `evaluatorId` vanished from the
    // derived set the same way an unresolvable syntax form used to, with no test noticing either.
    function addIfDeclared(literal: string): void {
      const known = declared.get(literal);
      if (known === undefined) {
        throw new Error(
          `${entry}: an "evaluatorId" property is assigned the literal "${literal}", which is ` +
            'not a declared evaluatorDefinitions id -- add the definition, or fix the typo.',
        );
      }
      ids.add(known);
    }

    function resolveIdentifierAlias(name: string): void {
      const alias = topLevelStringConsts.get(name);
      if (alias === undefined) {
        throw new Error(
          `${entry}: an "evaluatorId" property is assigned from identifier "${name}", which is ` +
            'not a same-file top-level string const this test can resolve -- extend ' +
            'derivedProducerIds() to handle this form, or use a literal or a top-level const.',
        );
      }
      addIfDeclared(alias);
    }

    // A computed key naming a same-file top-level string const (`{ [EVALUATOR_ID_KEY]: ... }`)
    // resolves the same way a value identifier alias does. Review found this test treating a
    // computed Identifier key as categorically dynamic and skipping it unconditionally, which let
    // a valid producer using that form vanish from the derived set the same way an unresolved
    // value used to, with no test noticing. Unlike `resolveIdentifierAlias`, an unresolvable key
    // here does not necessarily name `evaluatorId` at all, so this only throws when the key *is*
    // computed -- a computed key this test cannot statically read is not safe to silently skip,
    // because it might be exactly the property this test exists to find.
    function resolveKeyAlias(name: string): string {
      const alias = topLevelStringConsts.get(name);
      if (alias === undefined) {
        throw new Error(
          `${entry}: an object property's computed key is the identifier "${name}", which is ` +
            'not a same-file top-level string const this test can resolve -- extend ' +
            'derivedProducerIds() to handle this form, or use a literal, a top-level const, or ' +
            'a non-computed key.',
        );
      }
      return alias;
    }

    walk(ast.program, (node) => {
      if (!t.isObjectExpression(node)) return;
      for (const prop of node.properties) {
        if (!t.isObjectProperty(prop)) continue;
        // A key can be an Identifier (`evaluatorId: ...`), a StringLiteral (`'evaluatorId': ...`),
        // a computed literal (`['evaluatorId']: ...`), or a computed identifier naming a same-file
        // top-level string const (`[EVALUATOR_ID_KEY]: ...`) -- review found this test skipping
        // the StringLiteral form, then the computed-literal form, then this last one, with no
        // throw any time, letting such a producer vanish from the derived set without failing any
        // test. Only a non-computed Identifier key can be `shorthand`.
        const keyName = t.isStringLiteral(prop.key)
          ? prop.key.value
          : t.isIdentifier(prop.key)
            ? prop.computed
              ? resolveKeyAlias(prop.key.name)
              : prop.key.name
            : undefined;
        if (keyName !== 'evaluatorId') continue;

        if (prop.shorthand) {
          // `{ ...base, evaluatorId, payload }` -- the property's own name is the value.
          resolveIdentifierAlias(keyName);
          continue;
        }
        const value = prop.value;
        if (t.isStringLiteral(value)) {
          addIfDeclared(value.value);
          continue;
        }
        if (t.isIdentifier(value)) {
          resolveIdentifierAlias(value.name);
          continue;
        }
        if (
          t.isMemberExpression(value) &&
          !value.computed &&
          t.isIdentifier(value.object) &&
          value.object.name === 'spec' &&
          t.isIdentifier(value.property) &&
          value.property.name === 'evaluatorId'
        ) {
          continue; // the one verified pass-through: pushCandidate forwarding spec.evaluatorId
        }
        throw new Error(
          `${entry}: an "evaluatorId" property has a value this test cannot statically resolve ` +
            `to a string (a ${value.type} node) -- extend derivedProducerIds() to handle this form.`,
        );
      }
    });
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

it(
  "derivedProducerIds()'s AST approach is justified: this repository's pinned typescript " +
    'package still exposes no classic Compiler API to parse with instead',
  () => {
    const ts: Record<string, unknown> = createRequire(import.meta.url)('typescript');
    expect(
      typeof ts['createSourceFile'],
      'typescript now exports createSourceFile -- the doc comment above derivedProducerIds() ' +
        'claims this repository cannot use the classic Compiler API for that reason; if this ' +
        'starts failing, re-read that comment and decide whether the AST approach is still needed',
    ).not.toBe('function');
  },
);

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
        // Anchored to the placeholder's own label, not a bare substring search. Review found the
        // bare form false-passes: pronoun-antecedent-ambiguity's real offsetInPassage is 0, and
        // its own template carries unrelated boilerplate reading "offsets are 0-based" -- so
        // `rendered.toContain('0')` was satisfied by that text even when {{offsetInPassage}}'s own
        // placeholder rendered as "none". Confirmed by construction: replacing the real render's
        // correct "...passage: 0" with "...passage: none" left `rendered.includes('0')` still true.
        // `labeledExpectation` finds the text template.user itself carries immediately before
        // {{variable}}, on the same line, and requires that label followed by the real value to
        // appear together in the rendered output -- pinning each value to its own placeholder's
        // position instead of to the passage anywhere.
        const labeled = labeledExpectation(template.user, variable, expected);
        expect(
          rendered,
          `${gapKey}: rendered request does not carry the real candidate's value for ` +
            `{{${variable}}} at its own label -- buildEvaluatorRequest resolved it from ` +
            `somewhere else, or another field's text happens to contain the same value`,
        ).toContain(labeled);
      }
    });
  }
});

/**
 * The text `template.user` carries immediately before `{{variable}}`, from the start of that
 * line, concatenated with `expected`. Checking this combined string, rather than `expected` alone,
 * requires the rendered request to carry the value at the position its own placeholder occupies,
 * not merely anywhere in the passage or another field's rendered text.
 *
 * A placeholder that begins its own line (`{{passage}}` on a bare line, for instance) yields an
 * empty label here, which reduces to the original bare check for that one case -- still correct,
 * since a value alone on its own line is already unlikely to collide with unrelated boilerplate
 * the way a short, common value substituted mid-line can.
 *
 * A line can carry more than one placeholder --
 * `noun-cluster-comprehension`'s "Cluster length: {{length}} (configured limit: {{limit}})" is
 * one -- so the label cannot simply be "back to the start of the line": for `{{limit}}`, that
 * would include `{{length}}`'s own literal, unrendered brace syntax, which never appears in a
 * real rendered request (it is always substituted first). Caught by this function's own first
 * version failing exactly that case when run. The label instead starts right after the nearest
 * earlier placeholder's closing `}}` on the same line, when one exists, so it only ever contains
 * text this template renders verbatim.
 */
function labeledExpectation(templateText: string, variable: string, expected: string): string {
  const placeholder = `{{${variable}}}`;
  const index = templateText.indexOf(placeholder);
  if (index === -1) {
    throw new Error(
      `template does not contain {{${variable}}} -- unreachable for a declared variable`,
    );
  }
  const lineStart = templateText.lastIndexOf('\n', index) + 1;
  const precedingClose = templateText.lastIndexOf('}}', index);
  const labelStart = precedingClose >= lineStart ? precedingClose + 2 : lineStart;
  const label = templateText.slice(labelStart, index);
  return label + expected;
}
