# Writing a rule

## Decide first: can the rule decide?

This is the only architecturally significant question.

- **Yes** — an exact, reproducible trigger with no inference. Emit `deterministic-violation`.
- **No** — the trigger is a _shape_ that may or may not be a defect. Emit a `CandidatePassage` for a
  semantic evaluator, and let it degrade to `review-required` when adjudication is off.

Getting this wrong is the most damaging mistake available. A heuristic reported as
`deterministic-violation` tells a reader the tool is certain when it is not. In a safety-relevant
document, false certainty is worse than saying nothing. Every rule that depends on the procedural or
descriptive classifier belongs in the second category. So does any rule that depends on part of
speech, or on meaning.

## Skeleton

`src/deterministic/rules/my-rule.ts`:

```ts
import { z } from 'zod';
import { buildDiagnostic, type DeterministicRule, type RuleOutput } from '../../core/rule.js';
import type { Diagnostic, RuleMetadata } from '../../core/types.js';
import { excerpt, findTerm, sentenceProseWords } from '../helpers.js';

const optionsSchema = z.object({
  threshold: z.number().int().min(1).default(3),
  allow: z.array(z.string()).default([]),
});

const meta: RuleMetadata = {
  id: 'my-rule', // stable forever; deprecate and add rather than rename
  title: 'Human-readable title',
  status: 'provisional', // only a rule pack may say otherwise
  sourceRef: 'provisional:docs/provisional-rules.md#my-rule',
  kind: 'deterministic',
  appliesTo: ['procedural'], // or ['descriptive'], or both
  defaultSeverity: 'warning',
  fixable: false,
  inspectsProtectedRegions: false, // true only if the rule must read literals
  description: 'One paragraph: what it triggers on, and what it deliberately does not.',
};

export const myRule: DeterministicRule<z.output<typeof optionsSchema>> = {
  meta,
  optionsSchema,
  run({ doc, options, pack, policy, blockById }): RuleOutput {
    const diagnostics: Diagnostic[] = [];
    for (const sentence of doc.sentences) {
      if (!meta.appliesTo.includes(sentence.mode)) continue;
      const words = sentenceProseWords(sentence); // protected tokens excluded
      if (words.length < options.threshold) continue;
      diagnostics.push(
        buildDiagnostic(meta, policy, {
          category: 'deterministic-violation',
          message: 'What is wrong, and what to do instead.',
          range: sentence.range, // absolute source offsets
          evidence: excerpt(sentence.raw),
        }),
      );
    }
    return { diagnostics, candidates: [] };
  },
};
```

Register it in `src/deterministic/index.ts`. **Append** the entry. Do not sort the array. Array order
is the run order. Array order is also part of the tool's deterministic behaviour. Add a `rules[]`
entry to `src/rule-pack/provisional-pack.ts`. Also add a section in `docs/provisional-rules.md`
matching your `sourceRef` anchor.

## Put every option constraint in the schema, including the ones between fields

The runner validates a rule's options with `optionsSchema.safeParse` before calling `run`. A failure
is reported as a `rule-options-invalid` notice that skips only that rule. Nothing wraps `run` itself.
A constraint the schema does not express becomes an exception. That exception aborts the analysis of
the whole document.

Per-field `min`/`max` does not cover a constraint that holds _between_ two fields. A pair of bounds
combined into a range needs a `.refine()` on the object as well. So does a regular-expression
`{min,max}` quantifier, a slice, or an index. `abbreviation-introduction` in
`src/deterministic/rules/mechanics.ts` is the worked example. Its options
`{ minLength: 8, maxLength: 3 }` satisfy both fields' individual ranges. Before the refinement
existed, those options still parsed. Then they threw `numbers out of order in {} quantifier` from the
`RegExp` constructor (issue #6). Give the refinement a `path` so the notice names the offending
option.

## Rules you do not implement yourself

The runner applies these after your rule returns, so do not try them:

| Do not                              | Because                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| set `severity`                      | `buildDiagnostic()` applies the policy, and the runner applies user overrides |
| check whether a span is protected   | the runner drops diagnostics that point only at protected content             |
| decide whether a fix may be applied | `gateFix()` runs on every fix, unconditionally                                |
| suppress `review-required`          | the diagnostic policy decides                                                 |
| call `fetch` or read files          | the boundary test forbids input or output operations in `src/deterministic`   |
| sort the output                     | the runner sorts by (start, end, ruleId)                                      |
| de-duplicate the output             | the runner's sort produces one deterministic order on its own                 |

## Reading text correctly

| Need                                   | Use                               | Why                                                                  |
| -------------------------------------- | --------------------------------- | -------------------------------------------------------------------- |
| match a word or phrase                 | `findTerm(sentence, term)`        | matches against `sentence.masked`, so it can never match inside code |
| a sentence's words for vocabulary work | `sentenceProseWords(sentence)`    | drops protected tokens                                               |
| a sentence's words for a length limit  | `sentence.words`                  | includes one word per content-bearing literal                        |
| the sentence's container               | `blockById.get(sentence.blockId)` | for `kind`, `admonition`, `listOrdinal`                              |
| raw source for a span                  | `doc.text.slice(start, end)`      | offsets are always absolute                                          |
| a limit or a word list                 | `pack.limits`, `pack.dictionary`  | never hard-code vocabulary                                           |

Never run a regex over `doc.text`. Use `sentence.masked` or `doc.maskedText`. That is what keeps
code, URLs, identifiers, and quantities from being read as prose.

That contract — read only `sentence.masked` and `sentence.words`, never `doc.text` — stays stable. It
holds even while the document-reading layer is rearchitected
([issue #25](https://github.com/Jamie-BitFlight/textlint-ASD-ai/issues/25)). A rule that only touches
already-masked, sentence-level data does not depend on the document-reading layer's implementation. It
behaves the same whether a block came from the current regex scanner or a future parser-backed
reader.

## Offering a fix

Set `meta.fixable: true` and attach a `TextFix`. Then expect it to be refused. Make sure the
diagnostic is still useful without the fix — the message gains a parenthetical explaining the
refusal.

A fix survives only if it meets every one of these conditions:

- It changes no digit, no negation, no modal verb, and no ordering word (`checkFixSafety`).
- It is outside every admonition.
- It does not overlap a protected region.
- It does not overlap another rule's fix.

Two rules disagreeing about the same characters causes **both** fixes to be refused.

For a fix driven by pack data, gate it on the pack's own `safeSubstitution` flag and say so in
`rationale`. Never infer that a substitution is safe.

Some rule categories must never offer a fix at all:

- anything touching quantities or tolerances
- commands or identifiers
- procedural order
- modal verbs
- ambiguous references
- safety-sensitive content

That is policy, not preference — see [`diagnostic-policy.md`](./diagnostic-policy.md#autofix-policy).

## Emitting a candidate instead

```ts
candidates.push({
  id: `${meta.id}:${sentence.id}:${range.start}`, // stable and unique
  ruleId: meta.id,
  evaluatorId: 'passive-voice-adjudication',
  range, // where the diagnostic will be anchored
  passage: sentence.masked, // what the model receives
  passageOffset: sentence.range.start, // maps an evidence span back to source
  payload: { construction, participle }, // ONLY keys the evaluator declares
  invariants: ['negation', 'modal force', 'action order'],
  reason: 'Auxiliary plus past participle.',
  mode: sentence.mode,
  admonition: sentence.admonition,
});
```

`payload` is the redaction mechanism. `buildEvaluatorRequest()` transmits only the keys the evaluator
declares in `payloadKeys`. It throws if the prompt references a key the evaluator does not declare.
Extra keys are dropped. A test asserts that an internal note in a payload never reaches the model.

Use `sentence.masked` for `passage`. Do not use `sentence.raw`, except when the evaluator genuinely
needs the literals. Before you do, think about what that transmits.

## Tests a rule needs

`test/unit/rules.test.ts` has a `describe` block per rule. A new rule needs, at minimum:

1. **positive** — the violation is found, and the reported span quotes the right text.
2. **negative** — the near-miss case is _not_ found.
3. **protected content** — the same wording inside inline code, a fence, a URL, or a path is ignored.
4. **options** — each option changes behaviour, and `{}` parses.
5. **fix** — the fix text is exact, and the refusal cases produce no fix.
6. **admonition** — nothing is fixed inside a warning.

Then check the corpus-wide invariants still hold:

```bash
vp test test/fixtures      # no diagnostic lands in a code fence; no fix lands in an admonition
vp test test/architecture  # boundaries intact
```

If your rule fires on the `hard-negative` fixtures, investigate before shipping. Those excerpts were
selected because a naive linter flags them wrongly.

## Honesty requirements

- Document the failure modes in `docs/provisional-rules.md`. Not the ones you imagine — the ones you
  observed running the rule over `fixtures/original/`.
- Do not describe a heuristic as certain compliance failure, in the message or the docs.
- If a rule needs meaning to be right, it emits a candidate. There is no third option.
