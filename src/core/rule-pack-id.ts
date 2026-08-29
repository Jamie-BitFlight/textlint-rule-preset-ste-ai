/**
 * The character set and length a rule-pack `metadata.id` may use.
 *
 * `id` is a match key — compared by exact string membership against `trustedRulePackIds`
 * (`src/rule-pack/loader.ts`) and, for the one bundled pack, by object identity
 * (`src/core/runner.ts`) — never prose meant to be read. Allows a leading `@` alongside
 * alphanumerics so an npm-scope-style id (`@acme/std`, the convention `docs/design/
 * 64-layered-rule-packs/02-authority-trust.md` already documents for a future layered pack) is
 * not rejected on its first character while every other character stays restricted.
 *
 * Defined in `core` rather than `rule-pack/schema.ts` so `core/runner.ts` can enforce it directly
 * at the point it interpolates an untrusted pack's id into a diagnostic (PR #116, round 11: a
 * caller of the public `runDeterministicRules` API can construct a `RulePack`-shaped object by
 * hand and skip `parseRulePack`/`rulePackMetadataSchema` entirely, so schema validation alone does
 * not protect that path — `core` cannot import `rule-pack` to call the schema either,
 * `test/architecture/module-boundaries.test.ts` forbids it). `rule-pack/schema.ts` imports this
 * same pattern for the schema-validated path, so there is one definition, not two that can drift.
 */
export const RULE_PACK_ID_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9._:@/+-]*$/;
export const RULE_PACK_ID_MAX_LENGTH = 128;

/** True only for an id every consumer (schema validation, or `runner.ts`'s direct check) treats as safe to interpolate as-is. */
export function isSafeRulePackId(id: string): boolean {
  return id.length > 0 && id.length <= RULE_PACK_ID_MAX_LENGTH && RULE_PACK_ID_PATTERN.test(id);
}
