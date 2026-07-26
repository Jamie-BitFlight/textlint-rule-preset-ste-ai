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
 * Three conditions, all required:
 *
 * 1. the pack declares `normative` authority;
 * 2. it declares a conformance claim other than `none`;
 * 3. **the operator has named the pack in `trustedRulePackIds`.**
 *
 * The third is the trust boundary. Schema validation proves a pack's shape, not its provenance:
 * any JSON file can assert `authority: "normative"`, so a pack cannot elevate itself. Authority is
 * supplier-*declared* metadata until an operator makes an explicit, auditable decision to accept
 * it. The bundled pack fails condition 1 regardless.
 *
 * There is no signature verification here. If you need cryptographic provenance rather than an
 * operator allowlist, verify the pack before handing it to this package and keep the allowlist as
 * the final gate.
 */
export function packPermitsConformanceClaim(
  pack: RulePack,
  trustedRulePackIds: readonly string[] = [],
): boolean {
  if (pack.metadata.authority !== 'normative') return false;
  if (pack.metadata.conformanceClaim === 'none') return false;
  return trustedRulePackIds.includes(pack.metadata.id);
}

/**
 * The authority the linter will act on, as distinct from the authority the pack claims.
 *
 * An untrusted pack's diagnostics report `supplementary` — its rule data is used, but its claim to
 * normative standing is not honoured. The pack's own assertion stays visible in
 * `metadata.authority` for the audit trail.
 */
export function verifiedAuthority(
  pack: RulePack,
  trustedRulePackIds: readonly string[] = [],
): RulePack['metadata']['authority'] {
  if (pack.metadata.authority !== 'normative') return pack.metadata.authority;
  return trustedRulePackIds.includes(pack.metadata.id) ? 'normative' : 'supplementary';
}

export { provisionalRulePack };
