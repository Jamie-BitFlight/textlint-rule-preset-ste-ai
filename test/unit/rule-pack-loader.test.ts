import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import type { RulePack } from '../../src/core/types.js';
import {
  RulePackError,
  loadRulePackFromFile,
  parseRulePack,
  provisionalRulePack,
  resolveRulePack,
  verifiedAuthority,
} from '../../src/rule-pack/loader.js';

/**
 * `src/rule-pack/loader.ts` is the trust boundary #67 found untested: nothing in `test/` imported
 * it directly before this file, so `resolveRulePack`'s input shapes, `loadRulePackFromFile`'s
 * failure modes, and `verifiedAuthority` were each exercised only incidentally, through whichever
 * higher-level test happened to route through them.
 *
 * `test/integration/rule-pack.test.ts` already pins the trust gate's user-visible behaviour
 * end-to-end (`analyseTextDeterministic`, per-rule status, `packPermitsConformanceClaim`). This
 * file is narrower: it calls the loader's exports directly, so a change to `resolveRulePack` or
 * `loadRulePackFromFile` fails here even when no rule happens to exercise the affected branch.
 */

function validPackJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    metadata: {
      id: 'direct-test-pack',
      name: 'Direct loader test pack',
      version: '1.0.0',
      authority: 'normative',
      licence: 'Proprietary — test fixture',
      source: 'Authored for this test. Not derived from any standard.',
      conformanceClaim: 'declared-by-supplier',
    },
    limits: {
      proceduralMaxGradeLevel: 7,
      descriptiveMaxGradeLevel: 8,
      sentenceReadabilityFloorWords: 20,
      maxNounClusterLength: 3,
      maxSentencesPerProceduralStep: 1,
    },
    dictionary: { approved: [], unapproved: [], preferred: [] },
    contractions: [],
    approvedTechnicalTerms: [],
    rules: [],
    ...overrides,
  };
}

function caughtError(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('resolveRulePack', () => {
  it('returns the bundled provisional pack when spec is undefined', () => {
    expect(resolveRulePack(undefined)).toBe(provisionalRulePack);
  });

  it('parses an inline object spec directly, without touching the filesystem', () => {
    const resolved = resolveRulePack(validPackJson());

    expect(resolved.metadata.id).toBe('direct-test-pack');
  });

  it('loads a string spec from disk, resolved against baseDir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ste-ai-loader-resolve-'));
    try {
      writeFileSync(join(dir, 'pack.json'), JSON.stringify(validPackJson()));

      const resolved = resolveRulePack('./pack.json', dir);

      expect(resolved.metadata.id).toBe('direct-test-pack');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadRulePackFromFile', () => {
  it('throws RulePackError, not a raw fs error, when the file is missing', () => {
    const error = caughtError(() => loadRulePackFromFile('/no/such/rule-pack.json'));

    expect(error).toBeInstanceOf(RulePackError);
    expect(error).toHaveProperty('message', expect.stringContaining('Cannot read rule pack'));
  });

  it('throws RulePackError, not a raw SyntaxError, on malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ste-ai-loader-malformed-'));
    try {
      const file = join(dir, 'pack.json');
      writeFileSync(file, '{ "metadata": ');

      const error = caughtError(() => loadRulePackFromFile(file));

      expect(error).toBeInstanceOf(RulePackError);
      expect(error).toHaveProperty('message', expect.stringContaining('not valid JSON'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws RulePackError with the failing field path when the file is schema-invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ste-ai-loader-invalid-schema-'));
    try {
      const file = join(dir, 'pack.json');
      writeFileSync(file, JSON.stringify(validPackJson({ metadata: undefined })));

      const error = caughtError(() => loadRulePackFromFile(file));

      expect(error).toBeInstanceOf(RulePackError);
      expect(error).toHaveProperty('message', expect.stringContaining('metadata'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseRulePack', () => {
  it('includes the supplied origin string in the thrown error', () => {
    const error = caughtError(() => parseRulePack({}, 'a distinctive origin marker'));

    expect(error).toBeInstanceOf(RulePackError);
    expect(error).toHaveProperty('message', expect.stringContaining('a distinctive origin marker'));
  });
});

describe('verifiedAuthority', () => {
  const normativePack: RulePack = parseRulePack(validPackJson(), 'test');
  const provisionalPack: RulePack = parseRulePack(
    validPackJson({
      metadata: {
        id: 'provisional-test-pack',
        name: 'Provisional test pack',
        version: '1.0.0',
        authority: 'provisional',
        licence: 'Proprietary — test fixture',
        source: 'Authored for this test.',
        conformanceClaim: 'none',
      },
    }),
    'test',
  );

  it('caps a normative pack at supplementary when its id is absent from trustedRulePackIds', () => {
    expect(verifiedAuthority(normativePack, [])).toBe('supplementary');
  });

  it('honours a normative pack once the operator names it in trustedRulePackIds', () => {
    expect(verifiedAuthority(normativePack, ['direct-test-pack'])).toBe('normative');
  });

  it('leaves a non-normative pack unchanged regardless of trust', () => {
    expect(verifiedAuthority(provisionalPack, [])).toBe('provisional');
    expect(verifiedAuthority(provisionalPack, ['provisional-test-pack'])).toBe('provisional');
  });

  it('defaults trustedRulePackIds to empty when omitted', () => {
    expect(verifiedAuthority(normativePack)).toBe('supplementary');
  });
});

describe('provisionalRulePack identity', () => {
  // `src/core/runner.ts` trusts `pack === provisionalRulePack` (genuine reference identity with
  // the one bundled-default singleton, imported directly from `core/default-pack.ts`) to decide
  // whether an untrusted pack's sourceRef citation can be honoured (#66). Two earlier mechanisms
  // were tried and both found forgeable by Codex review on PR #116: a declared `status` field
  // (round 1-2, a supplier's pack could just declare it), and a copyable `isBundledDefault` field
  // on the pack object (round 4-7, `{ ...provisionalRulePack, rules: attackerRules }` carries a
  // plain field through object spread along with every other own property). Reference identity is
  // the one thing spread cannot fake: `{ ...provisionalRulePack }` always allocates a new object.

  it('parseRulePack always returns a fresh object, never the bundled singleton', () => {
    const parsed = parseRulePack(validPackJson(), 'test');

    expect(parsed).not.toBe(provisionalRulePack);
  });

  it('a structurally identical copy of the bundled pack is not the bundled pack', () => {
    const copy = { ...provisionalRulePack };

    expect(copy).not.toBe(provisionalRulePack);
    expect(copy).toEqual(provisionalRulePack);
  });
});
