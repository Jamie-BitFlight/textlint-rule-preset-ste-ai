import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { RulePack } from '../core/types.js';
import { provisionalRulePack } from './provisional-pack.js';
import { rulePackSchema } from './schema.js';

export class RulePackError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RulePackError';
  }
}

/** Parse and validate an unknown value as a rule pack. */
export function parseRulePack(value: unknown, origin: string): RulePack {
  const result = rulePackSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new RulePackError(`Rule pack from ${origin} is invalid: ${issues}`);
  }
  return result.data;
}

export function loadRulePackFromFile(path: string, baseDir = process.cwd()): RulePack {
  const full = isAbsolute(path) ? path : resolve(baseDir, path);
  let raw: string;
  try {
    raw = readFileSync(full, 'utf8');
  } catch (error) {
    throw new RulePackError(`Cannot read rule pack at ${full}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RulePackError(`Rule pack at ${full} is not valid JSON`, { cause: error });
  }
  return parseRulePack(parsed, full);
}

/**
 * Resolve the rule pack for a run.
 *
 * With no `rulePack` configured the bundled provisional pack is returned. This is the documented
 * default and it is why every shipped rule reports `provisional` status.
 */
export function resolveRulePack(
  spec: string | Record<string, unknown> | undefined,
  baseDir = process.cwd(),
): RulePack {
  if (spec === undefined) return provisionalRulePack;
  if (typeof spec === 'string') return loadRulePackFromFile(spec, baseDir);
  return parseRulePack(spec, 'inline configuration');
}

/**
 * True when output is allowed to describe findings as conformance with a standard.
 *
 * The bundled pack always returns false. A pack must both declare `normative` authority and a
 * conformance claim other than `none` before any such wording is permitted, and even then the
 * wording comes from the pack supplier, not from this package.
 */
export function packPermitsConformanceClaim(pack: RulePack): boolean {
  return pack.metadata.authority === 'normative' && pack.metadata.conformanceClaim !== 'none';
}

export { provisionalRulePack };
