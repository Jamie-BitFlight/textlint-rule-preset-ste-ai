import { z } from 'zod';
import { buildDiagnostic, type DeterministicRule, type RuleOutput } from '../../core/rule.js';
import type {
  CandidatePassage,
  Diagnostic,
  PreferredTermEntry,
  RuleMetadata,
  TextFix,
} from '../../core/types.js';
import {
  excerpt,
  findCaseConflicts,
  findTerm,
  hasVisibleContent,
  matchCapitalisation,
  reportCaseConflict,
  reportUncheckedGroup,
  sanitizeQuotedValue,
  stripUnsafeCharacters,
} from '../helpers.js';

// ---------------------------------------------------------------------------
// unapproved-vocabulary
// ---------------------------------------------------------------------------

/**
 * An `alternatives` array's effective value for case-conflict comparison purposes: each entry
 * sanitized, then any entry with no visible content dropped entirely. Order is preserved and still
 * distinguishes two otherwise-equal-looking arrays, matching `unapprovedVocabularyRule.run()`'s own
 * use of `alternatives[0]` as the fix candidate (below) — this is the same two-step transform, not
 * a looser one.
 */
function effectiveAlternatives(alternatives: readonly string[]): string[] {
  return alternatives.map(stripUnsafeCharacters).filter(hasVisibleContent);
}

const unapprovedOptionsSchema = z
  .object({
    /** Additional terms to treat as unapproved: `{ "leverage": ["use"] }`. */
    additional: z.record(z.string(), z.array(z.string())).default({}),
    /** Terms from the pack to ignore in this project. */
    allow: z.array(z.string()).default([]),
    /**
     * Ask the semantic subsystem whether a flagged word is used in a sense the pack permits.
     * Off by default so the rule stays purely deterministic unless the operator opts in.
     */
    adjudicateSense: z.boolean().default(false),
  })
  .superRefine((options, ctx) => {
    // `additional` keys are matched case-insensitively (`findTerm` → `termPattern`), so `Use` and
    // `use` claim the same span; JSON key order would otherwise decide which alternatives list
    // applies. Reject only when the conflicting keys actually disagree (#125).
    //
    // Checked against `allow`-filtered entries, matching `run()`'s own `allow.has(entry.term
    // .toLowerCase())` filter (below): an operator can name-and-disable both sides of a conflict
    // via `allow` (`{ additional: { Use: [...], use: [...] }, allow: ['use'] }`), at which point
    // neither key ever reaches `findTerm` and there is no runtime ambiguity left to reject.
    const allow = new Set(options.allow.map((term) => term.toLowerCase()));
    const effective = Object.fromEntries(
      Object.entries(options.additional).filter(([term]) => !allow.has(term.toLowerCase())),
    );
    // Compared after the same two-step transform the raw alternatives get before they ever reach
    // a diagnostic or fix (below): `stripUnsafeCharacters`, then dropping any entry that sanitizes
    // to no visible content (`hasVisibleContent`). A follow-up round of the same review found that
    // comparing only the first step wasn't enough -- `Use` mapped to a single ZWJ (U+200D) and
    // `use` mapped to an empty array sanitize to different-looking raw arrays (`["‍"]` vs
    // `[]`), but the second step drops the invisible-only entry from both, so at the runtime the
    // rule actually reaches (below), both keys resolve to the identical empty alternatives list.
    // Comparing after only the first step rejected that non-conflict the same way comparing raw
    // values did before.
    const scan = findCaseConflicts(
      effective,
      (a, b) =>
        JSON.stringify(effectiveAlternatives(a)) === JSON.stringify(effectiveAlternatives(b)),
    );
    for (const group of scan.conflicts) reportCaseConflict(ctx, group, 'alternatives');
    for (const group of scan.unchecked) reportUncheckedGroup(ctx, group, 'alternatives');
  });

const unapprovedMeta: RuleMetadata = {
  id: 'unapproved-vocabulary',
  title: 'Unapproved general vocabulary',
  status: 'provisional',
  sourceRef: 'provisional:docs/provisional-rules.md#unapproved-vocabulary',
  kind: 'deterministic',
  appliesTo: ['procedural', 'descriptive'],
  defaultSeverity: 'error',
  fixable: true,
  inspectsProtectedRegions: false,
  description:
    'Reports a word or phrase listed as unapproved by the active rule pack and offers the ' +
    "pack's approved alternatives. A fix is attached only when the pack marks the substitution " +
    'as unable to change technical meaning.',
};

export const unapprovedVocabularyRule: DeterministicRule<z.output<typeof unapprovedOptionsSchema>> =
  {
    meta: unapprovedMeta,
    optionsSchema: unapprovedOptionsSchema,
    run({ doc, options, pack, policy }): RuleOutput {
      const diagnostics: Diagnostic[] = [];
      const candidates: CandidatePassage[] = [];
      const allow = new Set(options.allow.map((t) => t.toLowerCase()));

      const entries = [
        ...pack.dictionary.unapproved,
        ...Object.entries(options.additional).map(([term, alternatives]) => ({
          term,
          alternatives,
          safeSubstitution: false,
          note: 'Supplied by project configuration.',
        })),
      ].filter((entry) => !allow.has(entry.term.toLowerCase()));

      // Longest term first so `prior to` wins over a hypothetical `prior`.
      entries.sort((a, b) => b.term.length - a.term.length);

      for (const sentence of doc.sentences) {
        const claimed: { start: number; end: number }[] = [];
        for (const entry of entries) {
          for (const match of findTerm(sentence, entry.term)) {
            if (claimed.some((c) => match.range.start < c.end && c.start < match.range.end))
              continue;
            claimed.push(match.range);

            // Stripped once, here: `entry.alternatives` is supplier-controlled (the pack's
            // `unapprovedTermSchema.alternatives`, or a project's own `additional` entry) and
            // feeds every use below -- the displayed message, the fix `rationale`, the actual
            // `fix.text` a caller applies to the document, the `Diagnostic.suggestions` array
            // (`src/textlint/adapter.ts` builds its own rendered copy from this, but an editor's
            // "apply fix" path writes this array's own value straight into the file too), `meta`
            // (serialised verbatim by `steai lint --json`), and the semantic-adjudication payload
            // sent to the model. Stripping the source once, rather than at each render site, means
            // none of those sinks can be missed by a future addition to this list.
            // Filtered, not just mapped: a pack-supplied alternative made entirely of characters
            // `stripUnsafeCharacters` strips (control characters, bidi overrides), or entirely of
            // characters it intentionally leaves alone but which are invisible on their own (ZWJ,
            // ZWNJ, soft hyphen -- see `hasVisibleContent`'s doc comment), sanitizes to something
            // with no visible content. Keeping it here would offer that as a suggestion and, worse,
            // build a fix that replaces the matched term with nothing a reader can see --
            // `checkFixSafety`'s numeric/negation/modal/ordering checks do not catch this for an
            // ordinary word, so it would reach `--fix` unchallenged. Treating this the same as "no
            // alternative supplied" is the same fallback already below for an empty `alternatives`
            // array.
            const alternatives = entry.alternatives
              .map(stripUnsafeCharacters)
              .filter((alternative) => hasVisibleContent(alternative));
            const safeTerm = stripUnsafeCharacters(entry.term);
            const suggestion = alternatives[0];
            let fix: TextFix | undefined;
            if (entry.safeSubstitution && suggestion !== undefined) {
              fix = {
                range: match.range,
                text: matchCapitalisation(match.text, suggestion),
                rationale:
                  `Rule pack marks "${sanitizeQuotedValue(safeTerm)}" → ` +
                  `"${sanitizeQuotedValue(suggestion)}" as meaning-preserving.`,
                safety: 'deterministic-meaning-preserving',
              };
            }

            const alternativeText =
              alternatives.length > 0
                ? ` Use ${alternatives.map((a) => `"${sanitizeQuotedValue(a)}"`).join(' or ')}.`
                : ' The rule pack supplies no approved alternative; rewrite the sentence.';

            diagnostics.push(
              buildDiagnostic(unapprovedMeta, policy, {
                category: 'deterministic-violation',
                message: `"${match.text}" is not approved general vocabulary.${alternativeText}`,
                range: match.range,
                evidence: excerpt(sentence.raw),
                suggestions: alternatives,
                ...(fix === undefined ? {} : { fix }),
                meta: {
                  term: safeTerm,
                  safeSubstitution: entry.safeSubstitution,
                  ...(entry.note === undefined ? {} : { note: stripUnsafeCharacters(entry.note) }),
                },
              }),
            );

            if (options.adjudicateSense) {
              candidates.push({
                id: `${unapprovedMeta.id}:${sentence.id}:${match.range.start}`,
                ruleId: unapprovedMeta.id,
                evaluatorId: 'approved-word-sense',
                range: match.range,
                passage: sentence.masked,
                passageOffset: sentence.range.start,
                payload: {
                  word: match.text,
                  approvedAlternatives: alternatives,
                  offsetInPassage: match.range.start - sentence.range.start,
                },
                invariants: ['technical meaning', 'quantities', 'identifiers', 'negation'],
                reason: 'Word is listed as unapproved; confirm the sense used here.',
                mode: sentence.mode,
                admonition: sentence.admonition,
              });
            }
          }
        }
      }
      return { diagnostics, candidates };
    },
  };

// ---------------------------------------------------------------------------
// preferred-terminology
// ---------------------------------------------------------------------------

/**
 * A `to` value's effective replacement for case-conflict comparison purposes: the sanitized value
 * itself, or a canonical empty string when that sanitized value has no visible content. Two
 * replacements that each sanitize to no visible content compare equal here even if their raw,
 * invisible-only content differs, since `preferredTerminologyRule`'s own `hasReplacement` check
 * (below) treats both identically as "no usable replacement" at runtime.
 */
function effectiveReplacement(to: string): string {
  const safe = stripUnsafeCharacters(to);
  return hasVisibleContent(safe) ? safe : '';
}

const preferredOptionsSchema = z
  .object({
    /** Extra mappings: `{ "log in": "sign in" }`. Never fixed automatically. */
    additional: z.record(z.string(), z.string()).default({}),
    allow: z.array(z.string()).default([]),
  })
  .superRefine((options, ctx) => {
    // Same case-insensitive span-matching conflict, the same allow-filtering, and the same
    // effective-value comparison before checking it, as `unapproved-vocabulary` above (#125) --
    // see that schema's `superRefine` doc comment for both.
    const allow = new Set(options.allow.map((term) => term.toLowerCase()));
    const effective = Object.fromEntries(
      Object.entries(options.additional).filter(([term]) => !allow.has(term.toLowerCase())),
    );
    const scan = findCaseConflicts(
      effective,
      (a, b) => effectiveReplacement(a) === effectiveReplacement(b),
    );
    for (const group of scan.conflicts) reportCaseConflict(ctx, group, 'replacements');
    for (const group of scan.unchecked) reportUncheckedGroup(ctx, group, 'replacements');
  });

const preferredMeta: RuleMetadata = {
  id: 'preferred-terminology',
  title: 'Preferred terminology',
  status: 'provisional',
  sourceRef: 'provisional:docs/provisional-rules.md#preferred-terminology',
  kind: 'deterministic',
  appliesTo: ['procedural', 'descriptive'],
  defaultSeverity: 'warning',
  fixable: true,
  inspectsProtectedRegions: false,
  description:
    'Enforces one spelling or wording for a concept, from the active rule pack plus project ' +
    'configuration. Fixes are attached only for pack entries flagged as meaning-preserving.',
};

export const preferredTerminologyRule: DeterministicRule<z.output<typeof preferredOptionsSchema>> =
  {
    meta: preferredMeta,
    optionsSchema: preferredOptionsSchema,
    run({ doc, options, pack, policy }): RuleOutput {
      const allow = new Set(options.allow.map((t) => t.toLowerCase()));
      const entries: PreferredTermEntry[] = [
        ...pack.dictionary.preferred,
        ...Object.entries(options.additional).map(([from, to]) => ({
          from,
          to,
          safeSubstitution: false,
          note: 'Supplied by project configuration.',
        })),
      ].filter((entry) => !allow.has(entry.from.toLowerCase()));
      entries.sort((a, b) => b.from.length - a.from.length);

      const diagnostics: Diagnostic[] = [];
      for (const sentence of doc.sentences) {
        const claimed: { start: number; end: number }[] = [];
        for (const entry of entries) {
          for (const match of findTerm(sentence, entry.from)) {
            if (claimed.some((c) => match.range.start < c.end && c.start < match.range.end))
              continue;
            claimed.push(match.range);
            // Stripped once: `entry.to`/`entry.from` are supplier-controlled and feed the fix
            // text actually written to the document, `Diagnostic.suggestions`, and `meta`
            // (serialised verbatim by `steai lint --json`), not only the rendered message and
            // rationale below.
            const safeFrom = stripUnsafeCharacters(entry.from);
            const safeTo = stripUnsafeCharacters(entry.to);
            // A pack-supplied `to` with no visible content once sanitized -- whether every
            // character was stripped outright, or what remains is only invisible format characters
            // like a lone ZWJ (see `hasVisibleContent`'s doc comment) -- would build a fix that
            // replaces the matched term with nothing a reader can see; `checkFixSafety` does not
            // catch this for an ordinary word, so an unguarded fix would reach `--fix` unchallenged.
            const hasReplacement = hasVisibleContent(safeTo);
            const replacement = hasReplacement
              ? matchCapitalisation(match.text, safeTo)
              : undefined;
            const fix: TextFix | undefined =
              entry.safeSubstitution && replacement !== undefined
                ? {
                    range: match.range,
                    text: replacement,
                    rationale:
                      `Rule pack marks "${sanitizeQuotedValue(safeFrom)}" → ` +
                      `"${sanitizeQuotedValue(safeTo)}" as a spelling choice.`,
                    safety: 'deterministic-meaning-preserving',
                  }
                : undefined;
            const message = hasReplacement
              ? `Use "${sanitizeQuotedValue(safeTo)}" instead of "${match.text}".`
              : `"${match.text}" should not be used here, but the rule pack's replacement is ` +
                'blank once sanitized.';
            diagnostics.push(
              buildDiagnostic(preferredMeta, policy, {
                category: 'deterministic-violation',
                message,
                range: match.range,
                evidence: excerpt(sentence.raw),
                suggestions: replacement === undefined ? [] : [replacement],
                ...(fix === undefined ? {} : { fix }),
                meta: {
                  from: safeFrom,
                  to: safeTo,
                  ...(entry.note === undefined ? {} : { note: stripUnsafeCharacters(entry.note) }),
                },
              }),
            );
          }
        }
      }
      return { diagnostics, candidates: [] };
    },
  };

// ---------------------------------------------------------------------------
// no-contractions
// ---------------------------------------------------------------------------

const contractionOptionsSchema = z.object({
  allow: z.array(z.string()).default([]),
});

const contractionMeta: RuleMetadata = {
  id: 'no-contractions',
  title: 'No contractions',
  status: 'provisional',
  sourceRef: 'provisional:docs/provisional-rules.md#no-contractions',
  kind: 'deterministic',
  appliesTo: ['procedural', 'descriptive'],
  defaultSeverity: 'error',
  fixable: true,
  inspectsProtectedRegions: false,
  description:
    'Reports contracted forms and expands them where the expansion is unambiguous. Ambiguous ' +
    'contractions such as "it\'s" (it is / it has) are reported without a fix.',
};

export const noContractionsRule: DeterministicRule<z.output<typeof contractionOptionsSchema>> = {
  meta: contractionMeta,
  optionsSchema: contractionOptionsSchema,
  run({ doc, options, pack, policy }): RuleOutput {
    const allow = new Set(options.allow.map((t) => t.toLowerCase()));
    const entries = pack.contractions.filter((e) => !allow.has(e.from.toLowerCase()));
    const diagnostics: Diagnostic[] = [];

    for (const sentence of doc.sentences) {
      for (const entry of entries) {
        // Match both the straight apostrophe and U+2019.
        for (const variant of variantsOf(entry.from)) {
          for (const match of findTerm(sentence, variant)) {
            // Stripped once: `entry.from`/`entry.to` are pack-supplied (`pack.contractions`) and
            // feed the fix text actually written to the document and `meta` (serialised verbatim
            // by `steai lint --json`), not only the rendered message and rationale. Matching above
            // still uses the raw `entry.from` -- stripping would not change a legitimate
            // contraction's apostrophe, but there is no reason to match against anything other
            // than what the pack actually declared.
            const safeFrom = stripUnsafeCharacters(entry.from);
            const safeTo = stripUnsafeCharacters(entry.to);
            // A pack-supplied expansion with no visible content once sanitized -- whether every
            // character was stripped outright, or what remains is only invisible format characters
            // like a lone ZWJ (see `hasVisibleContent`'s doc comment) -- would build a fix that
            // replaces the matched contraction with nothing a reader can see; `checkFixSafety` does
            // not catch this for an ordinary word, so an unguarded fix would reach `--fix`
            // unchallenged.
            const hasReplacement = hasVisibleContent(safeTo);
            const replacement = hasReplacement
              ? matchCapitalisation(match.text, safeTo)
              : undefined;
            const fix: TextFix | undefined =
              entry.safeSubstitution && replacement !== undefined
                ? {
                    range: match.range,
                    text: replacement,
                    rationale:
                      `"${sanitizeQuotedValue(safeFrom)}" expands unambiguously to ` +
                      `"${sanitizeQuotedValue(safeTo)}".`,
                    safety: 'deterministic-meaning-preserving',
                  }
                : undefined;
            const expansionText =
              replacement === undefined
                ? 'the rule pack supplies no usable expansion.'
                : `Write "${sanitizeQuotedValue(replacement)}".`;
            diagnostics.push(
              buildDiagnostic(contractionMeta, policy, {
                category: 'deterministic-violation',
                message:
                  `Do not use the contraction "${match.text}". ${expansionText}` +
                  (entry.safeSubstitution
                    ? ''
                    : ` ${entry.note === undefined ? 'Confirm the intended sense.' : stripUnsafeCharacters(entry.note)}`),
                range: match.range,
                evidence: excerpt(sentence.raw),
                suggestions: replacement === undefined ? [] : [replacement],
                ...(fix === undefined ? {} : { fix }),
                meta: { contraction: safeFrom, ambiguous: !entry.safeSubstitution },
              }),
            );
          }
        }
      }
    }
    return { diagnostics, candidates: [] };
  },
};

function variantsOf(term: string): string[] {
  if (!term.includes("'")) return [term];
  return [term, term.replace(/'/g, '’')];
}
