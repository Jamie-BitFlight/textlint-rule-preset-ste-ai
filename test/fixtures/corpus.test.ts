import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyseTextDeterministic } from '../../src/analysis/analyse.js';
import { annotationSchema } from '../../src/fixture-tools/annotation-schema.js';
import { extractProtectedLiterals, missingLiterals } from '../../src/fixture-tools/literals.js';
import { fixtureManifestSchema } from '../../src/fixture-tools/manifest-schema.js';
import { validateFixtureCorpus } from '../../src/fixture-tools/validate.js';

const FIXTURES = resolve(import.meta.dirname, '..', '..', 'fixtures');
const manifest = fixtureManifestSchema.parse(
  JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8')),
);

const pairs = manifest.fixtures
  .filter((f) => existsSync(join(FIXTURES, f.compliantPath)))
  .map((f) => ({
    fixture: f,
    original: readFileSync(join(FIXTURES, f.originalPath), 'utf8'),
    compliant: readFileSync(join(FIXTURES, f.compliantPath), 'utf8'),
    annotation: existsSync(join(FIXTURES, f.annotationPath))
      ? annotationSchema.parse(JSON.parse(readFileSync(join(FIXTURES, f.annotationPath), 'utf8')))
      : undefined,
  }));

describe('fixture provenance', () => {
  it('the corpus passes every provenance and integrity check', () => {
    const report = validateFixtureCorpus(FIXTURES);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('every fixture carries a licence quote long enough to be evidence', () => {
    for (const fixture of manifest.fixtures) {
      expect(fixture.licenceEvidence.quote.length, fixture.id).toBeGreaterThanOrEqual(10);
      expect(fixture.licenceEvidence.url, fixture.id).toMatch(/^https?:\/\//);
    }
  });

  it('no fixture is share-alike or copyleft licensed', () => {
    for (const fixture of manifest.fixtures) {
      expect(fixture.licence, fixture.id).not.toMatch(/share-?alike|GFDL|GPL|AGPL/i);
    }
  });

  it('the dev and heldout splits are disjoint by content', () => {
    const devShas = new Set(
      manifest.fixtures.filter((f) => f.split === 'dev').map((f) => f.originalSha256),
    );
    for (const fixture of manifest.fixtures.filter((f) => f.split === 'heldout')) {
      expect(devShas.has(fixture.originalSha256), `${fixture.id} leaks into dev`).toBe(false);
    }
  });

  it('no source page contributes to both splits', () => {
    // Byte-level disjointness is not enough. Two excerpts of one page share an author, a house
    // style, a vocabulary and a sentence rhythm, so tuning on one and quoting a number from the
    // other measures memorisation of that page. The split unit is therefore the source page, not
    // the excerpt: `mod_ssl.xml` and `sqlite.org/cli.html` each used to appear on both sides.
    const splitsByUrl = new Map<string, Set<string>>();
    for (const fixture of manifest.fixtures) {
      const seen = splitsByUrl.get(fixture.sourceUrl) ?? new Set<string>();
      seen.add(fixture.split);
      splitsByUrl.set(fixture.sourceUrl, seen);
    }
    const straddling = [...splitsByUrl.entries()]
      .filter(([, splits]) => splits.size > 1)
      .map(([url]) => url);
    expect(straddling).toEqual([]);
  });

  it('documents exactly which organisations still contribute to both splits', () => {
    // Organisation-level separation is stricter than page-level and this corpus cannot reach it
    // without losing a category from one side: OSHA supplies both safety-warning fixtures, and
    // moving both to one split would leave the other with no safety content — the highest-stakes
    // category. The overlap is therefore accepted and pinned here, so it stays a deliberate,
    // visible decision rather than an accident, and so adding a new source cannot widen it.
    const splitsByOrg = new Map<string, Set<string>>();
    for (const fixture of manifest.fixtures) {
      const seen = splitsByOrg.get(fixture.sourceOrganisation) ?? new Set<string>();
      seen.add(fixture.split);
      splitsByOrg.set(fixture.sourceOrganisation, seen);
    }
    const straddling = [...splitsByOrg.entries()]
      .filter(([, splits]) => splits.size > 1)
      .map(([org]) => org)
      .sort();
    expect(straddling).toEqual([
      'Occupational Safety and Health Administration (U.S. Department of Labor)',
    ]);
  });

  it('both splits cover a range of document categories', () => {
    for (const split of ['dev', 'heldout'] as const) {
      const categories = new Set(
        manifest.fixtures.filter((f) => f.split === split).map((f) => f.category),
      );
      expect(categories.size, `${split} covers too few categories`).toBeGreaterThanOrEqual(5);
      expect(categories, `${split} has no hard negative`).toContain('hard-negative');
    }
  });
});

describe('original fixtures produce diagnostics', () => {
  it('at least half the originals produce at least one diagnostic', () => {
    // Real documentation is not uniformly non-compliant; the corpus deliberately includes
    // hard negatives. What matters is that the rule set finds problems in genuine prose at all.
    const withFindings = manifest.fixtures.filter((fixture) => {
      const text = readFileSync(join(FIXTURES, fixture.originalPath), 'utf8');
      return analyseTextDeterministic(text, { path: fixture.originalPath }).diagnostics.length > 0;
    });
    expect(withFindings.length).toBeGreaterThanOrEqual(Math.ceil(manifest.fixtures.length / 2));
  });

  it('never reports inside a fenced code block of any fixture', () => {
    for (const fixture of manifest.fixtures) {
      const text = readFileSync(join(FIXTURES, fixture.originalPath), 'utf8');
      const analysis = analyseTextDeterministic(text, { path: fixture.originalPath });
      const fences = analysis.document.protectedRegions.filter((r) => r.kind === 'fenced-code');
      for (const diagnostic of analysis.diagnostics) {
        for (const fence of fences) {
          const inside =
            diagnostic.range.start >= fence.range.start && diagnostic.range.end <= fence.range.end;
          expect(inside, `${fixture.id}: ${diagnostic.ruleId} reported inside a code fence`).toBe(
            false,
          );
        }
      }
    }
  });

  it('every diagnostic on every fixture points at non-empty real source', () => {
    for (const fixture of manifest.fixtures) {
      const text = readFileSync(join(FIXTURES, fixture.originalPath), 'utf8');
      for (const d of analyseTextDeterministic(text, { path: fixture.originalPath }).diagnostics) {
        expect(d.range.end, `${fixture.id}/${d.ruleId}`).toBeGreaterThan(d.range.start);
        expect(text.slice(d.range.start, d.range.end).trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('never proposes a fix inside an admonition in any fixture', () => {
    for (const fixture of manifest.fixtures) {
      const text = readFileSync(join(FIXTURES, fixture.originalPath), 'utf8');
      const analysis = analyseTextDeterministic(text, { path: fixture.originalPath });
      const admonitionBlocks = analysis.document.blocks.filter((b) => b.admonition !== 'none');
      for (const d of analysis.diagnostics) {
        if (d.fix === undefined) continue;
        for (const block of admonitionBlocks) {
          const inside =
            d.fix.range.start >= block.range.start && d.fix.range.end <= block.range.end;
          expect(inside, `${fixture.id}: fix inside a ${block.admonition}`).toBe(false);
        }
      }
    }
  });
});

describe.skipIf(pairs.length === 0)('rewritten counterparts', () => {
  it('preserves every protected literal', () => {
    for (const pair of pairs) {
      expect(missingLiterals(pair.original, pair.compliant), pair.fixture.id).toEqual([]);
    }
  });

  it('never increases the number of deterministic violations', () => {
    for (const pair of pairs) {
      const before = analyseTextDeterministic(pair.original).diagnostics.filter(
        (d) => d.category === 'deterministic-violation',
      ).length;
      const after = analyseTextDeterministic(pair.compliant).diagnostics.filter(
        (d) => d.category === 'deterministic-violation',
      ).length;
      expect(after, `${pair.fixture.id}: ${before} → ${after}`).toBeLessThanOrEqual(before);
    }
  });

  it('reduces violations whenever the annotation accepted a change', () => {
    // A hard-negative fixture may legitimately have no accepted change: every finding on it is a
    // false positive the reviewer disputed. Requiring an unconditional reduction would push a
    // reviewer into rewriting correct prose, which is the opposite of what the corpus is for.
    for (const pair of pairs) {
      if (pair.annotation === undefined) continue;
      const accepted = pair.annotation.changes.filter(
        (c) =>
          c.status === 'accepted' &&
          c.expectedDiagnostics.some((e) => e.category === 'deterministic-violation'),
      );
      if (accepted.length === 0) continue;
      const before = analyseTextDeterministic(pair.original).diagnostics.filter(
        (d) => d.category === 'deterministic-violation',
      ).length;
      const after = analyseTextDeterministic(pair.compliant).diagnostics.filter(
        (d) => d.category === 'deterministic-violation',
      ).length;
      expect(
        after,
        `${pair.fixture.id}: ${accepted.length} accepted change(s) but ${before} → ${after}`,
      ).toBeLessThan(before);
    }
  });

  it('a fixture with no accepted change is explicitly documented as a hard negative', () => {
    for (const pair of pairs) {
      if (pair.annotation === undefined) continue;
      const accepted = pair.annotation.changes.filter((c) => c.status === 'accepted');
      if (accepted.length > 0) continue;
      expect(
        pair.fixture.category === 'hard-negative' || pair.annotation.notes !== undefined,
        `${pair.fixture.id}: no accepted change and no explanation`,
      ).toBe(true);
      expect(
        pair.annotation.changes.some((c) => c.status === 'disputed' || c.status === 'deferred'),
        `${pair.fixture.id}: no accepted change and nothing recorded as disputed or deferred`,
      ).toBe(true);
    }
  });

  it('clears every violation the annotation says it addresses', () => {
    // Counts, not presence. A short quote such as "!" or ";" can occur several times in one
    // document — for example inside an unfenced terminal transcript that the linter reads as prose.
    // Asserting absence would then fail even though the annotated occurrence really was fixed, so
    // the check is that the number of occurrences of that (ruleId, quote) pair went down.
    const countMatching = (text: string, ruleId: string, quote: string): number =>
      analyseTextDeterministic(text).diagnostics.filter(
        (d) => d.ruleId === ruleId && text.slice(d.range.start, d.range.end) === quote,
      ).length;

    for (const pair of pairs) {
      if (pair.annotation === undefined) continue;
      for (const change of pair.annotation.changes) {
        if (change.status !== 'accepted') continue;
        for (const expected of change.expectedDiagnostics) {
          if (expected.category !== 'deterministic-violation') continue;
          const before = countMatching(pair.original, expected.ruleId, expected.quote);
          const after = countMatching(pair.compliant, expected.ruleId, expected.quote);
          expect(
            after,
            `${pair.fixture.id}/${change.passageId}: ${expected.ruleId} on "${expected.quote}" went ${before} → ${after}; an accepted change must reduce it`,
          ).toBeLessThan(before);
        }
      }
    }
  });

  it('the annotated expected diagnostics actually fire on the original', () => {
    for (const pair of pairs) {
      if (pair.annotation === undefined) continue;
      const found = analyseTextDeterministic(pair.original).diagnostics;
      for (const change of pair.annotation.changes) {
        for (const expected of change.expectedDiagnostics) {
          if (expected.category !== 'deterministic-violation') continue;
          const match = found.filter(
            (d) =>
              d.ruleId === expected.ruleId &&
              pair.original.slice(d.range.start, d.range.end) === expected.quote,
          );
          expect(
            match.length,
            `${pair.fixture.id}/${change.passageId}: expected ${expected.ruleId} on "${expected.quote}" but it did not fire`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it('keeps the code fences of the original byte-identical', () => {
    for (const pair of pairs) {
      const fences = (text: string): string[] => {
        const doc = analyseTextDeterministic(text).document;
        return doc.protectedRegions
          .filter((r) => r.kind === 'fenced-code')
          .map((r) => text.slice(r.range.start, r.range.end));
      };
      expect(fences(pair.compliant), pair.fixture.id).toEqual(fences(pair.original));
    }
  });

  it('records at least one semantic invariant per change', () => {
    for (const pair of pairs) {
      if (pair.annotation === undefined) continue;
      for (const change of pair.annotation.changes) {
        expect(
          change.semanticInvariants.length,
          `${pair.fixture.id}/${change.passageId}`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe('literal extraction', () => {
  it('extracts commands, identifiers, quantities and paths', () => {
    const literals = extractProtectedLiterals(
      'Run `make install` at /etc/app and torque to 25 Nm.\n\n```sh\nmake -j4\n```\n',
    );
    expect(literals).toContain('`make install`');
    expect(literals).toContain('/etc/app');
    expect(literals).toContain('25 Nm');
    expect(literals.some((l) => l.includes('make -j4'))).toBe(true);
  });

  it('ignores structural markup, which a rewrite may change', () => {
    const literals = extractProtectedLiterals('- item one\n- item two\n');
    expect(literals).toEqual([]);
  });
});

describe('candidate ground truth', () => {
  /**
   * The semantic evaluators are measured against reviewer verdicts on candidate passages, and
   * nothing else. Before those verdicts existed the harness produced a confusion matrix of all
   * zeroes on every run — it looked like a working measurement and was incapable of measuring
   * anything. These tests keep that state from returning silently.
   */
  const runs = pairs.map((pair) => ({
    ...pair,
    candidates: analyseTextDeterministic(pair.original, { format: 'markdown' }).candidates,
  }));

  it('every candidate the linter emits has a reviewer verdict bound to its span', () => {
    const unlabelled: string[] = [];
    for (const { fixture, annotation, candidates } of runs) {
      for (const candidate of candidates) {
        const bound = (annotation?.candidateAdjudications ?? []).some(
          (record) =>
            record.ruleId === candidate.ruleId &&
            record.span.start < candidate.range.end &&
            candidate.range.start < record.span.end,
        );
        if (!bound) unlabelled.push(`${fixture.id}/${candidate.id} (${candidate.ruleId})`);
      }
    }
    expect(unlabelled).toEqual([]);
  });

  it('every verdict quotes the exact text at the span it claims', () => {
    for (const { fixture, original, annotation } of runs) {
      for (const record of annotation?.candidateAdjudications ?? []) {
        expect(
          original.slice(record.span.start, record.span.end),
          `${fixture.id}/${record.passageId}`,
        ).toBe(record.quote);
      }
    }
  });

  it('both splits carry labelled candidates, so neither is measurable only by accident', () => {
    for (const split of ['dev', 'heldout'] as const) {
      const labelled = runs
        .filter((r) => r.fixture.split === split)
        .reduce((sum, r) => sum + (r.annotation?.candidateAdjudications.length ?? 0), 0);
      expect(labelled, `${split} has no candidate ground truth`).toBeGreaterThan(0);
    }
  });

  it('records the measured class balance, which is what the metrics are worth', () => {
    const counts = { violation: 0, 'non-violation': 0, undecidable: 0 };
    for (const { annotation } of runs) {
      for (const record of annotation?.candidateAdjudications ?? []) counts[record.verdict] += 1;
    }
    // Four independent reviewers judged all 123 candidates and found 5 real defects. That is the
    // headline result of this corpus: the three heuristic candidate rules have a very high false
    // positive rate on well-edited technical documentation, and `noun-cluster-candidate` has no
    // observed true positive at all. The numbers are asserted so that a rule change which alters
    // them cannot pass unnoticed — and so that nobody quotes a recall figure built on five cases.
    expect(counts).toEqual({ violation: 5, 'non-violation': 118, undecidable: 0 });
  });

  it('no candidate rule is silently reclassified as reliable', () => {
    const perRule = new Map<string, { violation: number; total: number }>();
    for (const { annotation } of runs) {
      for (const record of annotation?.candidateAdjudications ?? []) {
        const entry = perRule.get(record.ruleId) ?? { violation: 0, total: 0 };
        entry.total += 1;
        if (record.verdict === 'violation') entry.violation += 1;
        perRule.set(record.ruleId, entry);
      }
    }
    // `noun-cluster-candidate` fired 35 times with zero confirmed defects. Documented in
    // docs/provisional-rules.md as an observed limit, not hidden.
    expect(perRule.get('noun-cluster-candidate')).toEqual({ violation: 0, total: 35 });
  });
});
