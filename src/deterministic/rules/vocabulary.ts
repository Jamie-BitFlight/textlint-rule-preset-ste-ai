import { z } from 'zod';
import { buildDiagnostic, type DeterministicRule, type RuleOutput } from '../../core/rule.js';
import type {
  CandidatePassage,
  Diagnostic,
  PreferredTermEntry,
  RuleMetadata,
  TextFix,
} from '../../core/types.js';
import { excerpt, findTerm, matchCapitalisation } from '../helpers.js';

// ---------------------------------------------------------------------------
// unapproved-vocabulary
// ---------------------------------------------------------------------------

const unapprovedOptionsSchema = z.object({
  /** Additional terms to treat as unapproved: `{ "leverage": ["use"] }`. */
  additional: z.record(z.string(), z.array(z.string())).default({}),
  /** Terms from the pack to ignore in this project. */
  allow: z.array(z.string()).default([]),
  /**
   * Ask the semantic subsystem whether a flagged word is used in a sense the pack permits.
   * Off by default so the rule stays purely deterministic unless the operator opts in.
   */
  adjudicateSense: z.boolean().default(false),
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

            const alternatives = entry.alternatives;
            const suggestion = alternatives[0];
            let fix: TextFix | undefined;
            if (entry.safeSubstitution && suggestion !== undefined) {
              fix = {
                range: match.range,
                text: matchCapitalisation(match.text, suggestion),
                rationale: `Rule pack marks "${entry.term}" → "${suggestion}" as meaning-preserving.`,
                safety: 'deterministic-meaning-preserving',
              };
            }

            const alternativeText =
              alternatives.length > 0
                ? ` Use ${alternatives.map((a) => `"${a}"`).join(' or ')}.`
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
                  term: entry.term,
                  safeSubstitution: entry.safeSubstitution,
                  ...(entry.note === undefined ? {} : { note: entry.note }),
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

const preferredOptionsSchema = z.object({
  /** Extra mappings: `{ "log in": "sign in" }`. Never fixed automatically. */
  additional: z.record(z.string(), z.string()).default({}),
  allow: z.array(z.string()).default([]),
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
            const replacement = matchCapitalisation(match.text, entry.to);
            const fix: TextFix | undefined = entry.safeSubstitution
              ? {
                  range: match.range,
                  text: replacement,
                  rationale: `Rule pack marks "${entry.from}" → "${entry.to}" as a spelling choice.`,
                  safety: 'deterministic-meaning-preserving',
                }
              : undefined;
            diagnostics.push(
              buildDiagnostic(preferredMeta, policy, {
                category: 'deterministic-violation',
                message: `Use "${entry.to}" instead of "${match.text}".`,
                range: match.range,
                evidence: excerpt(sentence.raw),
                suggestions: [replacement],
                ...(fix === undefined ? {} : { fix }),
                meta: {
                  from: entry.from,
                  to: entry.to,
                  ...(entry.note === undefined ? {} : { note: entry.note }),
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
            const replacement = matchCapitalisation(match.text, entry.to);
            const fix: TextFix | undefined = entry.safeSubstitution
              ? {
                  range: match.range,
                  text: replacement,
                  rationale: `"${entry.from}" expands unambiguously to "${entry.to}".`,
                  safety: 'deterministic-meaning-preserving',
                }
              : undefined;
            diagnostics.push(
              buildDiagnostic(contractionMeta, policy, {
                category: 'deterministic-violation',
                message:
                  `Do not use the contraction "${match.text}". Write "${replacement}".` +
                  (entry.safeSubstitution ? '' : ` ${entry.note ?? 'Confirm the intended sense.'}`),
                range: match.range,
                evidence: excerpt(sentence.raw),
                suggestions: [replacement],
                ...(fix === undefined ? {} : { fix }),
                meta: { contraction: entry.from, ambiguous: !entry.safeSubstitution },
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
