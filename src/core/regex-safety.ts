import { analyse } from 'scslre';
import { RegExpParser, visitRegExpAST, type AST } from '@eslint-community/regexpp';

export type RegexComplexityCategory =
  | 'nested-quantifier'
  | 'quantified-alternation'
  | 'quantified-optional'
  | 'adjacent-repetition';

export type RegexSafetyResult =
  | { readonly status: 'safe' }
  | {
      readonly status: 'vulnerable';
      readonly category: RegexComplexityCategory;
      readonly explanation: string;
    };

const parser = new RegExpParser({ ecmaVersion: 2022 });
const resultCache = new Map<string, RegexSafetyResult>();

function containsRangeQuantifier(node: AST.Node): boolean {
  let found = false;
  visitRegExpAST(node, {
    onQuantifierEnter(quantifier) {
      if (quantifier.min !== quantifier.max) found = true;
    },
  });
  return found;
}

function categoryFor(pattern: AST.Pattern): RegexComplexityCategory {
  let category: RegexComplexityCategory = 'adjacent-repetition';
  visitRegExpAST(pattern, {
    onQuantifierEnter(quantifier) {
      if (category !== 'adjacent-repetition') return;
      const element = quantifier.element;
      if (element.type !== 'Group' && element.type !== 'CapturingGroup') return;
      if (element.alternatives.length > 1) {
        category = 'quantified-alternation';
        return;
      }
      if (containsRangeQuantifier(element)) {
        const hasOptional = element.alternatives.some((alternative) =>
          alternative.elements.some((child) => child.type === 'Quantifier' && child.min === 0),
        );
        category = hasOptional ? 'quantified-optional' : 'nested-quantifier';
      }
    },
  });
  return category;
}

function explanationFor(category: RegexComplexityCategory): string {
  switch (category) {
    case 'nested-quantifier':
      return 'independent ReDoS analysis found super-linear backtracking through nested repetition';
    case 'quantified-alternation':
      return 'independent ReDoS analysis found super-linear backtracking through repeated alternatives';
    case 'quantified-optional':
      return 'independent ReDoS analysis found super-linear backtracking through repeated optional content';
    case 'adjacent-repetition':
      return 'independent ReDoS analysis found super-linear backtracking between repeated atoms';
  }
  return category satisfies never;
}

/** Analyse an ECMAScript Unicode pattern without running it against attacker-controlled input. */
export function analyseRegexSafety(source: string): RegexSafetyResult {
  const cached = resultCache.get(source);
  if (cached !== undefined) return cached;

  const pattern = parser.parsePattern(source, 0, source.length, true);
  const diagnostics = analyse({ source, flags: 'u' });
  const ambiguityReports = diagnostics.reports.filter((report) => report.type !== 'Move');

  let result: RegexSafetyResult;
  if (ambiguityReports.length > 0) {
    const category = categoryFor(pattern);
    result = { status: 'vulnerable', category, explanation: explanationFor(category) };
  } else {
    result = { status: 'safe' };
  }

  resultCache.set(source, result);
  return result;
}
