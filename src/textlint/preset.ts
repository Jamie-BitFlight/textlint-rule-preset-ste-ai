import type { TextlintRuleModule } from '@textlint/types';
import { deterministicRules } from '../deterministic/index.js';
import { createSteTextlintRule } from './adapter.js';

/**
 * textlint preset.
 *
 * Every deterministic core rule is exposed as an independent textlint rule module with its own
 * stable id. Referenced from `.textlintrc.json` as:
 *
 * ```json
 * { "plugins": ["@textlint/markdown"], "rules": { "preset-ste-ai": true } }
 * ```
 *
 * or per rule:
 *
 * ```json
 * { "rules": { "preset-ste-ai/sentence-length-procedural": { "maxWords": 18 } } }
 * ```
 */

const rules: Record<string, TextlintRuleModule> = {};
const rulesConfig: Record<string, boolean | Record<string, unknown>> = {};

for (const rule of deterministicRules) {
  rules[rule.meta.id] = createSteTextlintRule(rule.meta.id);
  rulesConfig[rule.meta.id] = true;
}

/** Rule modules keyed by bare rule id. */
export const steTextlintRules: Readonly<Record<string, TextlintRuleModule>> = rules;

const preset = { rules, rulesConfig };

export { rules, rulesConfig };
export default preset;
