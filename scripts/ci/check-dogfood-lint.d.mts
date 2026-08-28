/**
 * Hand-written type declarations for `check-dogfood-lint.mjs`'s exported pure functions, so a test
 * importing them gets real types instead of TypeScript's implicit `any` for an untyped `.mjs`
 * module. Kept in sync by hand: this script is deliberately plain JavaScript (see its own module
 * comment on `git ls-files` discovery and machine-writability), not a build target that emits its
 * own declarations.
 */

import type { TxtDocumentNode } from '@textlint/ast-node-types';

export interface ParagraphBounds {
  readonly start: number;
  readonly end: number;
}

export function toForwardSlashes(path: string): string;
export function paragraphBounds(source: string, index: number): ParagraphBounds;
export function sentenceBounds(source: string, index: number): ParagraphBounds;
export function localContext(source: string, index: number): string;
export function nearestHeading(source: string, index: number, ast?: TxtDocumentNode): string;
export function headingPath(source: string, index: number, ast?: TxtDocumentNode): string;
export function findingKey(
  ruleId: string,
  message: string,
  context: string,
  heading: string,
  ordinal: number,
): string;
export function splitFindingKey(key: string): {
  readonly ruleId: string;
  readonly message: string;
  readonly context: string;
};

export interface BaselineFileEntry {
  readonly total: number;
  readonly findings: Readonly<Record<string, number>>;
}

export type Baseline = Readonly<Record<string, BaselineFileEntry>>;

export interface Regression {
  readonly path: string;
  readonly ruleId: string;
  readonly message: string;
  readonly before: number;
  readonly after: number;
}

export function findRegressions(
  byFile: ReadonlyMap<string, ReadonlyMap<string, number>>,
  baseline: Baseline,
): Regression[];

export function regressionsToGuard(
  byFile: ReadonlyMap<string, ReadonlyMap<string, number>>,
  baselineExists: boolean,
  existing: Baseline,
): Regression[];

export function findImprovements(
  byFile: ReadonlyMap<string, ReadonlyMap<string, number>>,
  baseline: Baseline,
): string[];
