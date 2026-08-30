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
 * { "rules": { "preset-ste-ai/sentence-length-procedural": { "maxGradeLevel": 6 } } }
 * ```
 */

const rules: Record<string, TextlintRuleModule> = {};
const rulesConfig: Record<string, boolean | Record<string, unknown>> = {};

// Semantic candidate generators are intentionally opt-in in the edit-time preset. They are noisy,
// dominate output volume, and do not assert deterministic violations. Projects that want the
// deeper review pass can enable any of them explicitly.
const FAST_DEFAULT_DISABLED = new Set([
  'passive-voice-candidate',
  'noun-cluster-candidate',
  'ambiguous-pronoun-candidate',
]);

for (const rule of deterministicRules) {
  rules[rule.meta.id] = createSteTextlintRule(rule.meta.id);
  rulesConfig[rule.meta.id] = !FAST_DEFAULT_DISABLED.has(rule.meta.id);
}

/** Rule modules keyed by bare rule id. */
export const steTextlintRules: Readonly<Record<string, TextlintRuleModule>> = rules;

const preset = { rules, rulesConfig };

export { rules, rulesConfig };
export default preset;
