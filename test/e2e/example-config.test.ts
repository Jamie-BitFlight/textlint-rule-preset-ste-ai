import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { steAiConfigSchema } from '../../src/core/config.js';
import { deterministicRules } from '../../src/deterministic/index.js';

/**
 * The shipped example configuration files are documentation that executes. They were previously
 * neither executed nor validated by anything, and `.textlintrc.json` was written with
 * `"preset-ste-ai/<rule-id>"` keys — a shape textlint reads as *fourteen separate preset packages*,
 * none of which exist. The config loaded zero rules and printed "No rules found"; a reader copying
 * it got a linter that silently did nothing.
 *
 * These tests check the two failure modes that made that possible: the wrong nesting shape, and a
 * rule id that no longer exists.
 */

const exampleDir = fileURLToPath(new URL('../../examples/', import.meta.url));

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(exampleDir, name), 'utf8')) as Record<string, unknown>;
}

const coreRuleIds = new Set(deterministicRules.map((rule) => rule.meta.id));

describe('examples/.textlintrc.json', () => {
  const config = readJson('.textlintrc.json');
  const rules = config['rules'] as Record<string, unknown>;

  it('configures the preset as a single key with nested per-rule options', () => {
    // textlint's `isPresetRuleKey` matches on the `preset-` prefix and then resolves the *whole*
    // key as a package name, so a `/` in a preset key can never resolve.
    expect(Object.keys(rules)).toEqual(['preset-ste-ai']);
    for (const key of Object.keys(rules)) {
      expect(key).not.toContain('/');
    }
  });

  it('names only rules the preset actually exports', () => {
    const presetOptions = rules['preset-ste-ai'] as Record<string, unknown>;
    for (const ruleId of Object.keys(presetOptions)) {
      expect(coreRuleIds, `unknown rule id "${ruleId}"`).toContain(ruleId);
    }
  });

  it('names only plugins declared as dependencies of this package', () => {
    const plugins = config['plugins'] as Record<string, unknown>;
    expect(Object.keys(plugins).sort()).toEqual(['@textlint/markdown', '@textlint/text']);
  });
});

describe('examples/.ste-ai.json', () => {
  it('validates against the shared configuration schema', () => {
    const result = steAiConfigSchema.safeParse(readJson('.ste-ai.json'));
    const issues = result.success
      ? []
      : result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
    expect(issues).toEqual([]);
  });

  it('names only rules the linter actually has', () => {
    const config = readJson('.ste-ai.json');
    for (const ruleId of Object.keys(config['rules'] ?? {})) {
      expect(coreRuleIds, `unknown rule id "${ruleId}"`).toContain(ruleId);
    }
  });
});
