import { z } from 'zod';
import { buildDiagnostic, type DeterministicRule, type RuleOutput } from '../../core/rule.js';
import type { Diagnostic, RuleMetadata, SourceRange } from '../../core/types.js';
import { excerpt, sentenceProseWords } from '../helpers.js';

// ---------------------------------------------------------------------------
// punctuation-constraints
// ---------------------------------------------------------------------------

const punctuationOptionsSchema = z.object({
  forbidSemicolon: z.boolean().default(true),
  forbidSlashBetweenWords: z.boolean().default(true),
  forbidExclamation: z.boolean().default(true),
  forbidEllipsis: z.boolean().default(true),
  /** Parentheses inside an instruction hide a second statement. */
  forbidParenthesesInProcedural: z.boolean().default(true),
  /** 0 disables the check. */
  maxCommas: z.number().int().min(0).max(20).default(3),
});

const punctuationMeta: RuleMetadata = {
  id: 'punctuation-constraints',
  title: 'Punctuation constraints',
  status: 'provisional',
  sourceRef: 'provisional:docs/provisional-rules.md#punctuation-constraints',
  kind: 'deterministic',
  appliesTo: ['procedural', 'descriptive'],
  defaultSeverity: 'warning',
  fixable: false,
  inspectsProtectedRegions: false,
  description:
    'Reports punctuation that joins independent statements or adds ambiguity: semicolons, ' +
    'slashes between words, exclamation marks, ellipses, parentheses inside instructions, and ' +
    'more than the configured number of commas. No fix is offered because removing such ' +
    'punctuation always requires a decision about sentence structure.',
};

export const punctuationConstraintsRule: DeterministicRule<
  z.output<typeof punctuationOptionsSchema>
> = {
  meta: punctuationMeta,
  optionsSchema: punctuationOptionsSchema,
  run({ doc, options, policy }): RuleOutput {
    const diagnostics: Diagnostic[] = [];
    const report = (range: SourceRange, message: string, evidence: string, kind: string): void => {
      diagnostics.push(
        buildDiagnostic(punctuationMeta, policy, {
          category: 'deterministic-violation',
          message,
          range,
          evidence,
          meta: { punctuation: kind },
        }),
      );
    };

    for (const sentence of doc.sentences) {
      const base = sentence.range.start;
      const text = sentence.masked;
      const evidence = excerpt(sentence.raw);

      if (options.forbidSemicolon) {
        for (const m of text.matchAll(/;/g)) {
          report(
            { start: base + m.index, end: base + m.index + 1 },
            'A semicolon joins two statements. Write two sentences.',
            evidence,
            'semicolon',
          );
        }
      }
      if (options.forbidSlashBetweenWords) {
        for (const m of text.matchAll(/(?<=[\p{L}])\s?\/\s?(?=[\p{L}])/gu)) {
          report(
            { start: base + m.index, end: base + m.index + m[0].length },
            'A slash between words is ambiguous. Write "or", "and", or two sentences.',
            evidence,
            'slash',
          );
        }
      }
      if (options.forbidExclamation) {
        for (const m of text.matchAll(/!/g)) {
          report(
            { start: base + m.index, end: base + m.index + 1 },
            'Do not use an exclamation mark. State the instruction or the hazard plainly.',
            evidence,
            'exclamation',
          );
        }
      }
      if (options.forbidEllipsis) {
        for (const m of text.matchAll(/\.{3}|…/g)) {
          report(
            { start: base + m.index, end: base + m.index + m[0].length },
            'Do not use an ellipsis. Write the complete statement.',
            evidence,
            'ellipsis',
          );
        }
      }
      if (options.forbidParenthesesInProcedural && sentence.mode === 'procedural') {
        const open = text.indexOf('(');
        const close = text.indexOf(')', open + 1);
        if (open >= 0 && close > open) {
          report(
            { start: base + open, end: base + close + 1 },
            'Parenthetical text inside an instruction hides a second statement. Write it as its ' +
              'own sentence, or remove it.',
            evidence,
            'parentheses',
          );
        }
      }
      if (options.maxCommas > 0) {
        const commas = [...text.matchAll(/,/g)];
        if (commas.length > options.maxCommas) {
          const last = commas[commas.length - 1];
          if (last !== undefined) {
            report(
              { start: base + last.index, end: base + last.index + 1 },
              `This sentence has ${commas.length} commas; the limit is ${options.maxCommas}. ` +
                'Split it.',
              evidence,
              'commas',
            );
          }
        }
      }
    }
    return { diagnostics, candidates: [] };
  },
};

// ---------------------------------------------------------------------------
// no-repeated-words
// ---------------------------------------------------------------------------

const repeatedOptionsSchema = z.object({
  /** Words whose doubling can be intentional English. */
  allow: z.array(z.string()).default(['had', 'that']),
});

const repeatedMeta: RuleMetadata = {
  id: 'no-repeated-words',
  title: 'Repeated word',
  status: 'provisional',
  sourceRef: 'provisional:docs/provisional-rules.md#no-repeated-words',
  kind: 'deterministic',
  appliesTo: ['procedural', 'descriptive'],
  defaultSeverity: 'error',
  fixable: true,
  inspectsProtectedRegions: false,
  description:
    'Reports the same word twice in a row and removes the duplicate. The autofix gate refuses ' +
    'the deletion when it would change a negation count, so "not not" is reported without a fix.',
};

export const noRepeatedWordsRule: DeterministicRule<z.output<typeof repeatedOptionsSchema>> = {
  meta: repeatedMeta,
  optionsSchema: repeatedOptionsSchema,
  run({ doc, options, policy }): RuleOutput {
    const allow = new Set(options.allow.map((w) => w.toLowerCase()));
    const diagnostics: Diagnostic[] = [];

    for (const sentence of doc.sentences) {
      const words = sentenceProseWords(sentence);
      for (let i = 1; i < words.length; i += 1) {
        const previous = words[i - 1];
        const current = words[i];
        if (previous === undefined || current === undefined) continue;
        if (previous.lower !== current.lower) continue;
        if (allow.has(current.lower)) continue;
        // Only adjacent words separated by whitespace count as a doubling.
        const between = doc.text.slice(previous.range.end, current.range.start);
        if (!/^\s+$/.test(between)) continue;

        diagnostics.push(
          buildDiagnostic(repeatedMeta, policy, {
            category: 'deterministic-violation',
            message: `The word "${current.text}" is repeated. Remove the duplicate.`,
            range: { start: previous.range.start, end: current.range.end },
            evidence: excerpt(sentence.raw),
            suggestions: [previous.text],
            fix: {
              range: { start: previous.range.end, end: current.range.end },
              text: '',
              rationale: 'Deleting an immediately repeated word cannot change meaning.',
              safety: 'deterministic-meaning-preserving',
            },
            meta: { word: current.lower },
          }),
        );
      }
    }
    return { diagnostics, candidates: [] };
  },
};

// ---------------------------------------------------------------------------
// abbreviation-introduction
// ---------------------------------------------------------------------------

/**
 * Abbreviations exempt from introduction by default.
 *
 * PROVENANCE: implementation assumption. These are abbreviations and command keywords that
 * appear unexpanded in the public documentation of every project in the fixture corpus.
 * Projects should tune the list.
 */
const DEFAULT_WELL_KNOWN: readonly string[] = [
  'AC',
  'ANALYZE',
  'API',
  'ASCII',
  'CD',
  'CLI',
  'CPU',
  'CSS',
  'CSV',
  'DC',
  'DNS',
  'DVD',
  'FAQ',
  'GB',
  'GPS',
  'GUI',
  'HTML',
  'HTTP',
  'HTTPS',
  'ID',
  'IP',
  'JSON',
  'KB',
  'LED',
  'MB',
  'OK',
  'OS',
  'PC',
  'PDF',
  'PRAGMA',
  'RAM',
  'ROM',
  'RPM',
  'SDK',
  'SI',
  'SQL',
  'SSH',
  'SSL',
  'TB',
  'TCP',
  'TLS',
  'TV',
  'UDP',
  'URL',
  'USB',
  'UTC',
  'VACUUM',
  'XML',
  'YAML',
];

const abbreviationOptionsSchema = z.object({
  minLength: z.number().int().min(2).max(10).default(2),
  maxLength: z.number().int().min(2).max(12).default(6),
  /** Abbreviations that need no introduction. Replaces the default list when set. */
  wellKnown: z.array(z.string()).optional(),
  /** Extra abbreviations added to the default list. */
  additionalWellKnown: z.array(z.string()).default([]),
});

const abbreviationMeta: RuleMetadata = {
  id: 'abbreviation-introduction',
  title: 'Abbreviation introduction',
  status: 'provisional',
  sourceRef: 'provisional:docs/provisional-rules.md#abbreviation-introduction',
  kind: 'deterministic',
  appliesTo: ['procedural', 'descriptive'],
  defaultSeverity: 'warning',
  fixable: false,
  inspectsProtectedRegions: false,
  description:
    'Reports the first use of an abbreviation that is not introduced by its expansion, in either ' +
    'the "Full Name (ABC)" or "ABC (Full Name)" form. Only the first use is reported.',
};

export const abbreviationIntroductionRule: DeterministicRule<
  z.output<typeof abbreviationOptionsSchema>
> = {
  meta: abbreviationMeta,
  optionsSchema: abbreviationOptionsSchema,
  run({ doc, options, policy }): RuleOutput {
    const wellKnown = new Set(
      (options.wellKnown ?? DEFAULT_WELL_KNOWN).concat(options.additionalWellKnown),
    );
    const diagnostics: Diagnostic[] = [];
    const seen = new Set<string>();
    const re = new RegExp(`\\b[A-Z]{${options.minLength},${options.maxLength}}s?\\b`, 'g');

    for (const sentence of doc.sentences) {
      for (const m of sentence.masked.matchAll(re)) {
        const raw = m[0];
        const token = raw.endsWith('s') ? raw.slice(0, -1) : raw;
        if (token.length < options.minLength) continue;
        if (wellKnown.has(token)) continue;
        if (seen.has(token)) continue;
        seen.add(token);

        const start = sentence.range.start + m.index;
        const end = start + raw.length;
        if (isIntroduced(doc.text, token, start, end)) continue;

        diagnostics.push(
          buildDiagnostic(abbreviationMeta, policy, {
            category: 'deterministic-violation',
            message:
              `"${token}" is used before it is introduced. Write the full term followed by ` +
              `"(${token})" at the first use.`,
            range: { start, end },
            evidence: excerpt(sentence.raw),
            meta: { abbreviation: token },
          }),
        );
      }
    }
    return { diagnostics, candidates: [] };
  },
};

/**
 * True when the occurrence at `[start, end)` is an introduction.
 *
 * Two accepted forms:
 * - `LED (Light Emitting Diode)` — the abbreviation is followed by a parenthesis;
 * - `Light Emitting Diode (LED)` — the abbreviation sits inside a parenthesis, which is the
 *   conventional way of glossing the words that precede it.
 */
function isIntroduced(text: string, _token: string, start: number, end: number): boolean {
  if (/^\s*\(/.test(text.slice(end, end + 4))) return true;
  if (/\(\s*$/.test(text.slice(Math.max(0, start - 3), start))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// number-unit-format
// ---------------------------------------------------------------------------

const numberUnitOptionsSchema = z.object({
  /**
   * `required` — a space is required between a number and its unit.
   * `forbidden` — no space is permitted.
   * `off` — the check is disabled.
   */
  unitSpacing: z.enum(['required', 'forbidden', 'off']).default('required'),
  /** Units written directly against the number by convention. */
  noSpaceUnits: z.array(z.string()).default(['%', '°', '″', '′']),
  /** Report a decimal comma, which is ambiguous in mixed-locale documentation. */
  forbidDecimalComma: z.boolean().default(true),
});

const numberUnitMeta: RuleMetadata = {
  id: 'number-unit-format',
  title: 'Number and unit format',
  status: 'provisional',
  sourceRef: 'provisional:docs/provisional-rules.md#number-unit-format',
  kind: 'deterministic',
  appliesTo: ['procedural', 'descriptive'],
  defaultSeverity: 'warning',
  fixable: false,
  inspectsProtectedRegions: true,
  description:
    'Checks the spacing between a quantity and its unit, and reports a decimal comma. This is ' +
    'the one rule that reads inside protected numeric expressions. It never offers a fix: the ' +
    'autofix policy forbids automated edits to quantities.',
};

export const numberUnitFormatRule: DeterministicRule<z.output<typeof numberUnitOptionsSchema>> = {
  meta: numberUnitMeta,
  optionsSchema: numberUnitOptionsSchema,
  run({ doc, options, policy }): RuleOutput {
    if (options.unitSpacing === 'off' && !options.forbidDecimalComma) {
      return { diagnostics: [], candidates: [] };
    }
    const diagnostics: Diagnostic[] = [];
    const noSpace = new Set(options.noSpaceUnits);

    for (const region of doc.protectedRegions) {
      if (region.kind !== 'numeric-expression') continue;
      const raw = doc.text.slice(region.range.start, region.range.end);

      if (options.unitSpacing !== 'off') {
        const m = /^([+±-]?\d+(?:[.,]\d+)?)(\s*)([^\s\d].*)$/.exec(raw);
        const unit = m?.[3];
        const gap = m?.[2];
        // Capture group 1 is not optional in the regex above, so it is always populated whenever `m`
        // matches; the `string | undefined` type here is only `noUncheckedIndexedAccess` being unable
        // to see that. `quantity` makes the always-true case explicit instead of leaving an unguarded
        // `m[1]` that would silently interpolate as the literal text "undefined" if that invariant
        // were ever broken by a future regex edit. `RegExp.exec` also returns `RegExpExecArray | null`,
        // never `undefined`, so the guard below only checks against `null`.
        const quantity = m?.[1];
        if (m !== null && unit !== undefined && gap !== undefined && quantity !== undefined) {
          const exempt = noSpace.has(unit) || noSpace.has(unit.charAt(0));
          if (!exempt && options.unitSpacing === 'required' && gap.length === 0) {
            diagnostics.push(
              buildDiagnostic(numberUnitMeta, policy, {
                category: 'deterministic-violation',
                message: `Put a space between the number and the unit: "${quantity} ${unit}".`,
                range: region.range,
                evidence: raw,
                suggestions: [`${quantity} ${unit}`],
                meta: { quantity: raw, expectedSpacing: 'required' },
              }),
            );
          }
          if (!exempt && options.unitSpacing === 'forbidden' && gap.length > 0) {
            diagnostics.push(
              buildDiagnostic(numberUnitMeta, policy, {
                category: 'deterministic-violation',
                message: `Remove the space between the number and the unit: "${quantity}${unit}".`,
                range: region.range,
                evidence: raw,
                suggestions: [`${quantity}${unit}`],
                meta: { quantity: raw, expectedSpacing: 'forbidden' },
              }),
            );
          }
        }
      }

      if (options.forbidDecimalComma && /^\s*[+±-]?\d+,\d+(?!\d)/.test(raw)) {
        diagnostics.push(
          buildDiagnostic(numberUnitMeta, policy, {
            category: 'deterministic-violation',
            message:
              'A comma as a decimal separator is ambiguous in documentation read across ' +
              'locales. Use a full stop.',
            range: region.range,
            evidence: raw,
            meta: { quantity: raw, issue: 'decimal-comma' },
          }),
        );
      }
    }
    return { diagnostics, candidates: [] };
  },
};
