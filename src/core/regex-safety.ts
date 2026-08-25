import { parseRegExpLiteral } from '@eslint-community/regexpp';
import { checkSync } from 'recheck';
import { isZeroLength } from 'regexp-ast-analysis';

export type RegexSafetyResult =
  | { readonly status: 'safe'; readonly matchesOnlyEmpty: boolean }
  | { readonly status: 'inconclusive'; readonly explanation: string }
  | { readonly status: 'vulnerable'; readonly explanation: string };

/**
 * Apply community-owned ECMAScript parsing, zero-length analysis, and ReDoS detection.
 */
export function analyseRegexSafety(source: string): RegexSafetyResult {
  try {
    const literal = parseRegExpLiteral(new RegExp(source, 'gu'));
    const matchesOnlyEmpty = isZeroLength(literal.pattern.alternatives, literal.flags);
    const diagnostics = checkSync(source, 'gu', {
      checker: 'auto',
      timeout: 1_000,
      attackTimeout: 100,
      incubationTimeout: 100,
      seedingTimeout: 100,
    });

    if (diagnostics.status === 'unknown') {
      return {
        status: 'inconclusive',
        explanation: `the ReDoS analysis was inconclusive (${diagnostics.error.kind})`,
      };
    }
    if (diagnostics.status === 'vulnerable') {
      return {
        status: 'vulnerable',
        explanation: `ReDoS analysis found ${diagnostics.complexity.summary} backtracking`,
      };
    }
    return { status: 'safe', matchesOnlyEmpty };
  } catch (error) {
    return {
      status: 'inconclusive',
      explanation: `the regular-expression analysis failed (${
        error instanceof Error ? error.message : String(error)
      })`,
    };
  }
}
