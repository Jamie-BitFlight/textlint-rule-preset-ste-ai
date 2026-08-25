import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';
import {
  analyseTextDeterministic,
  type AnalyseTextOptions,
  type AnalysisResult,
} from '../../src/analysis/analyse.js';
import { annotationSchema } from '../../src/fixture-tools/annotation-schema.js';
import { extractProtectedLiterals, missingLiterals } from '../../src/fixture-tools/literals.js';
import { fixtureManifestSchema } from '../../src/fixture-tools/manifest-schema.js';
import { validateFixtureCorpus } from '../../src/fixture-tools/validate.js';

const FIXTURES = resolve(import.meta.dirname, '..', '..', 'fixtures');
const manifest = fixtureManifestSchema.parse(
  JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8')),
);

/**
 * Every deterministic analysis this file performs, memoised on (document, options).
 *
 * A deterministic analysis re-runs wink-nlp, compromise and sentence-splitter over a whole
 * document, while the corpus holds each original and its rewritten counterpart only once.
 * Re-analysing per assertion therefore repeated the same work across this file's assertions, at a
 * cost that dominated its runtime. One analysis per (document, options) pair serves every assertion
 * below without changing what any of them assert.
 *
 * The key carries the options as well as the document, so two tests that analyse the same text
 * under different options never share a result: the originals are analysed with a `path`, without
 * options, and as explicit markdown, and those are three different inputs to the analyser. Every
 * option used in this file is plain data, so `JSON.stringify` is a faithful identity for it.
 */
const analyses = new Map<string, AnalysisResult>();
const analyse = (key: string, text: string, options: AnalyseTextOptions = {}): AnalysisResult => {
  const cacheKey = `${key} ${JSON.stringify(options)}`;
  const cached = analyses.get(cacheKey);
  if (cached !== undefined) return cached;
  const result = analyseTextDeterministic(text, options);
  analyses.set(cacheKey, result);
  return result;
};

/** Each original, read once. `originalPath` is also the memo key for its analyses. */
const originals = manifest.fixtures.map((fixture) => ({
  fixture,
  text: readFileSync(join(FIXTURES, fixture.originalPath), 'utf8'),
}));

const analyseOriginalAtPath = (entry: (typeof originals)[number]): AnalysisResult =>
  analyse(entry.fixture.originalPath, entry.text, { path: entry.fixture.originalPath });

const pairs = originals
  .filter(({ fixture }) => existsSync(join(FIXTURES, fixture.compliantPath)))
  .map(({ fixture, text }) => ({
    fixture,
    original: text,
    compliant: readFileSync(join(FIXTURES, fixture.compliantPath), 'utf8'),
    annotation: existsSync(join(FIXTURES, fixture.annotationPath))
      ? annotationSchema.parse(
          JSON.parse(readFileSync(join(FIXTURES, fixture.annotationPath), 'utf8')),
        )
      : undefined,
  }));

/** Code-unit order, so fixture selection below does not depend on the runner's locale. */
const byId = (a: { fixture: { id: string } }, b: { fixture: { id: string } }): number =>
  a.fixture.id < b.fixture.id ? -1 : a.fixture.id > b.fixture.id ? 1 : 0;

/**
 * Counts, not presence. A short quote such as "!" or ";" can occur several times in one document
 * (for example inside an unfenced terminal transcript that the linter reads as prose). Asserting
 * absence would then fail even though the annotated occurrence really was fixed, so the check is
 * that the number of occurrences of that (ruleId, quote) pair went down.
 */
const countMatching = (key: string, text: string, ruleId: string, quote: string): number =>
  analyse(key, text).diagnostics.filter(
    (d) => d.ruleId === ruleId && text.slice(d.range.start, d.range.end) === quote,
  ).length;

/** A fenced-code region's exact source text, byte-identical check between two documents. */
const fences = (key: string, text: string): string[] =>
  analyse(key, text)
    .document.protectedRegions.filter((r) => r.kind === 'fenced-code')
    .map((r) => text.slice(r.range.start, r.range.end));

const deterministicViolations = (key: string, text: string): number =>
  analyse(key, text).diagnostics.filter((d) => d.category === 'deterministic-violation').length;

describe('fixture provenance', () => {
  it('the corpus passes every provenance and integrity check', () => {
    const report = validateFixtureCorpus(FIXTURES);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('refuses a rewritten fixture whose committed content changed', () => {
    // Selected by id among the fixtures that have a committed counterpart, not by manifest
    // position: `manifest.fixtures[0]` happened to have one, so reordering the manifest or adding
    // an entry at the top would silently move this test onto a different document, or onto one
    // with no counterpart at all, where the write would create a file instead of mutating one and
    // the assertion would pass for the wrong reason.
    const target = pairs.toSorted(byId)[0];
    if (target === undefined) throw new Error('no fixture has a rewritten counterpart');
    const copy = mkdtempSync(join(tmpdir(), 'ste-ai-fixtures-'));
    try {
      cpSync(FIXTURES, copy, { recursive: true });
      const path = join(copy, target.fixture.compliantPath);
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);

      const report = validateFixtureCorpus(copy);

      expect(report.ok).toBe(false);
      expect(report.failures).toContainEqual(
        expect.stringContaining(`${target.fixture.id}": compliantSha256 mismatch`),
      );
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it('rejects unknown fields in fixture and annotation records', () => {
    // Also selected by id rather than manifest position, and it must be an annotation that
    // actually records a change, because the third assertion adds a field to `changes[0]`.
    const target = pairs
      .filter((pair) => (pair.annotation?.changes.length ?? 0) > 0)
      .toSorted(byId)[0];
    if (target === undefined) throw new Error('no annotation records a change');
    const manifestInput = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'));
    const annotationInput = JSON.parse(
      readFileSync(join(FIXTURES, target.fixture.annotationPath), 'utf8'),
    );

    expect(fixtureManifestSchema.safeParse({ ...manifestInput, unrecognised: true }).success).toBe(
      false,
    );
    expect(annotationSchema.safeParse({ ...annotationInput, unrecognised: true }).success).toBe(
      false,
    );
    expect(
      annotationSchema.safeParse({
        ...annotationInput,
        changes: [{ ...annotationInput.changes[0], unrecognised: true }],
      }).success,
    ).toBe(false);
  });

  it('every licence evidence link points at a web page', () => {
    // The scheme, and only the scheme. `licenceEvidenceSchema` already requires a parsable URL and
    // a quote of at least ten characters, and `validate.ts` re-checks the quote length on the
    // trimmed string; both are reached through the corpus-wide check above. What neither
    // constrains is the protocol: `z.url()` accepts `mailto:` or `file:`, and evidence nobody else
    // can fetch is not evidence.
    for (const fixture of manifest.fixtures) {
      expect(fixture.licenceEvidence.url, fixture.id).toMatch(/^https?:\/\//);
    }
  });

  it('no source page contributes to both splits', () => {
    // Byte-level disjointness is not enough, and `validate.ts` already refuses that weaker
    // property. Two excerpts of one page share an author, a house style, a vocabulary and a
    // sentence rhythm, so tuning on one and quoting a number from the other measures memorisation
    // of that page. The split unit is therefore the source page, not the excerpt: `mod_ssl.xml`
    // and `sqlite.org/cli.html` each used to appear on both sides.
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
    // moving both to one split would leave the other with no safety content, the highest-stakes
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
      .toSorted();
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
    const withFindings = originals.filter(
      (entry) => analyseOriginalAtPath(entry).diagnostics.length > 0,
    );
    expect(withFindings.length).toBeGreaterThanOrEqual(Math.ceil(manifest.fixtures.length / 2));
  });

  it('never reports inside a fenced code block of any fixture', () => {
    for (const entry of originals) {
      const analysis = analyseOriginalAtPath(entry);
      const fencedRegions = analysis.document.protectedRegions.filter(
        (r) => r.kind === 'fenced-code',
      );
      for (const diagnostic of analysis.diagnostics) {
        for (const fence of fencedRegions) {
          const inside =
            diagnostic.range.start >= fence.range.start && diagnostic.range.end <= fence.range.end;
          expect(
            inside,
            `${entry.fixture.id}: ${diagnostic.ruleId} reported inside a code fence`,
          ).toBe(false);
        }
      }
    }
  });

  it('every diagnostic on every fixture points at non-empty real source', () => {
    for (const entry of originals) {
      for (const d of analyseOriginalAtPath(entry).diagnostics) {
        expect(d.range.end, `${entry.fixture.id}/${d.ruleId}`).toBeGreaterThan(d.range.start);
        expect(entry.text.slice(d.range.start, d.range.end).trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('never proposes a fix inside an admonition in any fixture', () => {
    for (const entry of originals) {
      const analysis = analyseOriginalAtPath(entry);
      const admonitionBlocks = analysis.document.blocks.filter((b) => b.admonition !== 'none');
      for (const d of analysis.diagnostics) {
        if (d.fix === undefined) continue;
        for (const block of admonitionBlocks) {
          const inside =
            d.fix.range.start >= block.range.start && d.fix.range.end <= block.range.end;
          expect(inside, `${entry.fixture.id}: fix inside a ${block.admonition}`).toBe(false);
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
      const before = deterministicViolations(pair.fixture.originalPath, pair.original);
      const after = deterministicViolations(pair.fixture.compliantPath, pair.compliant);
      expect(after, `${pair.fixture.id}: ${before} to ${after}`).toBeLessThanOrEqual(before);
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
      const before = deterministicViolations(pair.fixture.originalPath, pair.original);
      const after = deterministicViolations(pair.fixture.compliantPath, pair.compliant);
      expect(
        after,
        `${pair.fixture.id}: ${accepted.length} accepted change(s) but ${before} to ${after}`,
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
    for (const pair of pairs) {
      if (pair.annotation === undefined) continue;
      for (const change of pair.annotation.changes) {
        if (change.status !== 'accepted') continue;
        for (const expected of change.expectedDiagnostics) {
          if (expected.category !== 'deterministic-violation') continue;
          const before = countMatching(
            pair.fixture.originalPath,
            pair.original,
            expected.ruleId,
            expected.quote,
          );
          const after = countMatching(
            pair.fixture.compliantPath,
            pair.compliant,
            expected.ruleId,
            expected.quote,
          );
          expect(
            after,
            `${pair.fixture.id}/${change.passageId}: ${expected.ruleId} on "${expected.quote}" went ${before} to ${after}; an accepted change must reduce it`,
          ).toBeLessThan(before);
        }
      }
    }
  });

  it('the annotated expected diagnostics actually fire on the original', () => {
    for (const pair of pairs) {
      if (pair.annotation === undefined) continue;
      const found = analyse(pair.fixture.originalPath, pair.original).diagnostics;
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
      expect(fences(pair.fixture.compliantPath, pair.compliant), pair.fixture.id).toEqual(
        fences(pair.fixture.originalPath, pair.original),
      );
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

/**
 * A reviewer run: the file `merge-candidate-verdicts.mjs` merges into the annotations, and the only
 * record of a verdict that exists outside the artefact that merge produces.
 */
const verdictFileSchema = z.object({
  reviewer: z.string().min(1),
  reviewerKind: z.enum(['human', 'agent']),
  verdicts: z.record(
    z.string(),
    z.array(
      z.object({
        ruleId: z.string().min(1),
        evaluatorId: z.string().min(1),
        quote: z.string().min(1),
        span: z.object({ start: z.number(), end: z.number() }),
        verdict: z.enum(['violation', 'non-violation', 'undecidable']),
        reason: z.string().min(10),
        reviewerConfidence: z.number().min(0).max(1),
      }),
    ),
  ),
});

interface AdjudicationRow {
  readonly fixtureId: string;
  readonly ruleId: string;
  readonly span: string;
  readonly evaluatorId: string;
  readonly quote: string;
  readonly verdict: string;
  readonly reason: string;
  readonly reviewer: string;
  readonly reviewerKind: string;
  readonly reviewerConfidence: number;
}

/**
 * `passageId` is deliberately absent from the comparison: the schema documents it as a run-local
 * label embedding a sentence ordinal, and the merge tool takes it from the candidate packet rather
 * than from the verdict, so the two sides legitimately disagree on it wherever segmentation has
 * moved since the review. Rule and span are what everything else joins on.
 */
const rowKey = (row: AdjudicationRow): string => `${row.fixtureId} ${row.ruleId} ${row.span}`;
const byRowKey = (a: AdjudicationRow, b: AdjudicationRow): number =>
  rowKey(a) < rowKey(b) ? -1 : rowKey(a) > rowKey(b) ? 1 : 0;

describe('candidate ground truth', () => {
  /**
   * The semantic evaluators are measured against reviewer verdicts on candidate passages, and
   * nothing else. Before those verdicts existed the harness produced a confusion matrix of all
   * zeroes on every run: it looked like a working measurement and was incapable of measuring
   * anything. These tests keep that state from returning silently.
   */
  const runs = pairs.map((pair) => ({
    ...pair,
    candidates: analyse(pair.fixture.originalPath, pair.original, { format: 'markdown' })
      .candidates,
  }));

  it('every candidate has a verdict bound to its span, and every verdict a live candidate', () => {
    // Both directions. A rule change that moves or adds a candidate orphans the ground truth, and
    // a rule change that stops emitting one leaves a verdict describing a passage the evaluators
    // are never scored on. The second direction was previously checked only by
    // `scripts/ci/check-candidate-ground-truth.sh`, which needs a built `dist/` and so does not run
    // under `vp test`.
    const unlabelled: string[] = [];
    const orphaned: string[] = [];
    for (const { fixture, annotation, candidates } of runs) {
      const records = annotation?.candidateAdjudications ?? [];
      for (const candidate of candidates) {
        const bound = records.some(
          (record) =>
            record.ruleId === candidate.ruleId &&
            record.span.start < candidate.range.end &&
            candidate.range.start < record.span.end,
        );
        if (!bound) unlabelled.push(`${fixture.id}/${candidate.id} (${candidate.ruleId})`);
      }
      for (const record of records) {
        const live = candidates.some(
          (candidate) =>
            record.ruleId === candidate.ruleId &&
            record.span.start < candidate.range.end &&
            candidate.range.start < record.span.end,
        );
        if (!live) orphaned.push(`${fixture.id}/${record.passageId} (${record.ruleId})`);
      }
    }
    expect(unlabelled).toEqual([]);
    expect(orphaned).toEqual([]);
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

  it('every adjudication says exactly what a reviewer run recorded', () => {
    // This replaces two aggregates, the global class balance and one per-rule tally, that were
    // written here as literal numbers. Both survived any balanced edit:
    // `scripts/ci/check-annotation-provenance.sh` measured a demotion of the corpus's two confirmed
    // `passive-voice-candidate` defects, paired with a promotion of two other passages, passing
    // every gate while silently changing which passages the semantic evaluators are scored
    // against. A record-by-record comparison against `fixtures/verdicts/` fails on exactly that
    // edit, and it is derived from the corpus rather than transcribed from it, so no number here
    // needs maintaining when a fixture is added.
    //
    // What those numbers documented is still true and still readable from the corpus: four
    // independent agent reviewers judged 105 candidates and found 5 real defects, so the three
    // heuristic candidate rules have a very high false positive rate on well-edited technical
    // documentation, and nobody should quote a recall figure built on five cases.
    const recorded: AdjudicationRow[] = [];
    for (const file of readdirSync(join(FIXTURES, 'verdicts')).filter((f) => f.endsWith('.json'))) {
      const run = verdictFileSchema.parse(
        JSON.parse(readFileSync(join(FIXTURES, 'verdicts', file), 'utf8')),
      );
      for (const [fixtureId, rows] of Object.entries(run.verdicts)) {
        for (const row of rows) {
          recorded.push({
            fixtureId,
            ruleId: row.ruleId,
            span: `${row.span.start}-${row.span.end}`,
            evaluatorId: row.evaluatorId,
            quote: row.quote,
            verdict: row.verdict,
            reason: row.reason,
            reviewer: run.reviewer,
            reviewerKind: run.reviewerKind,
            reviewerConfidence: row.reviewerConfidence,
          });
        }
      }
    }

    const committed: AdjudicationRow[] = [];
    for (const { fixture, annotation } of runs) {
      for (const record of annotation?.candidateAdjudications ?? []) {
        committed.push({
          fixtureId: fixture.id,
          ruleId: record.ruleId,
          span: `${record.span.start}-${record.span.end}`,
          evaluatorId: record.evaluatorId,
          quote: record.quote,
          verdict: record.verdict,
          reason: record.reason,
          reviewer: record.reviewer,
          reviewerKind: record.reviewerKind,
          reviewerConfidence: record.reviewerConfidence,
        });
      }
    }

    // Non-vacuity, so an empty set of verdicts cannot satisfy the comparison: the confusion matrix
    // needs at least one confirmed defect to be anything other than zeroes.
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.filter((row) => row.verdict === 'violation').length).toBeGreaterThan(0);
    expect(committed.toSorted(byRowKey)).toEqual(recorded.toSorted(byRowKey));
  });
});
