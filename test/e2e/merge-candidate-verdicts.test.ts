import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `scripts/merge-candidate-verdicts.mjs` is the only thing that writes the ground truth the
 * semantic evaluators are scored against, and until this file existed nothing exercised it. That
 * was not a theoretical gap. Two of its guarantees could each be deleted outright with every gate
 * in the project still passing:
 *
 * - **`reviewerKind` is required.** The field exists so a record can say whether a person or an
 *   agent produced it; without a test, hard-coding `'agent'` at the write site and dropping the
 *   check on the input would have looked exactly like a working build.
 * - **`--check` compares against the committed annotations.** It used to validate that the
 *   verdicts bind to live passages and stop there, never opening `fixtures/annotations/`. A record
 *   edited by hand in the file the script writes passed CI untouched.
 *
 * The corpus is not used here. These are properties of the tool, and asserting them against the
 * real 105-record corpus would make them fail for reasons that have nothing to do with the tool.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const script = 'scripts/merge-candidate-verdicts.mjs';

const span = { start: 10, end: 14 };

/** One candidate, and the verdict that binds to it. Enough for the tool; nothing more. */
const candidate = {
  passageId: 'ambiguous-pronoun-candidate:s1:10',
  ruleId: 'ambiguous-pronoun-candidate',
  evaluatorId: 'pronoun-antecedent-ambiguity',
  quote: 'them',
  span,
};

const verdictRow = {
  ...candidate,
  verdict: 'non-violation',
  reason: 'The pronoun has exactly one plural antecedent in the preceding clause.',
  reviewerConfidence: 0.9,
};

interface Layout {
  readonly root: string;
  readonly verdicts: string;
  readonly packets: string;
  readonly fixtures: string;
}

const roots: string[] = [];

/**
 * A three-directory corpus of one fixture, shaped the way the real one is: a packet holding the
 * candidate, a verdict file holding the judgement, and an annotation the merge writes into.
 */
function makeCorpus(reviewerDoc: Record<string, unknown>): Layout {
  const root = mkdtempSync(join(tmpdir(), 'ste-ai-merge-'));
  roots.push(root);
  const verdicts = join(root, 'verdicts');
  const packets = join(root, 'packets');
  const fixtures = join(root, 'fixtures');
  mkdirSync(verdicts);
  mkdirSync(packets);
  mkdirSync(join(fixtures, 'annotations'), { recursive: true });

  writeFileSync(
    join(packets, 'demo.json'),
    JSON.stringify({ fixtureId: 'demo', candidates: [candidate] }),
  );
  writeFileSync(join(verdicts, 'reviewer-a.json'), JSON.stringify(reviewerDoc));
  writeFileSync(
    join(fixtures, 'manifest.json'),
    JSON.stringify({ fixtures: [{ id: 'demo', annotationPath: 'annotations/demo.json' }] }),
  );
  writeFileSync(
    join(fixtures, 'annotations', 'demo.json'),
    JSON.stringify({ fixtureId: 'demo', reviewers: ['rewriter-a'], changes: [] }),
  );
  return { root, verdicts, packets, fixtures };
}

function run(layout: Layout, ...extra: readonly string[]) {
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--verdicts',
      layout.verdicts,
      '--packets',
      layout.packets,
      '--fixtures',
      layout.fixtures,
      ...extra,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return { status: result.status, stderr: result.stderr };
}

function readAnnotation(layout: Layout): Record<string, unknown> {
  return JSON.parse(readFileSync(join(layout.fixtures, 'annotations', 'demo.json'), 'utf8'));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('merge-candidate-verdicts', () => {
  it('stamps the declared reviewerKind onto every record it writes', () => {
    const layout = makeCorpus({
      reviewer: 'reviewer-a',
      reviewerKind: 'agent',
      verdicts: { demo: [verdictRow] },
    });

    expect(run(layout).status).toBe(0);

    const annotation = readAnnotation(layout);
    expect(annotation['candidateAdjudications']).toEqual([
      {
        ...candidate,
        verdict: 'non-violation',
        reason: verdictRow.reason,
        reviewer: 'reviewer-a',
        reviewerKind: 'agent',
        reviewerConfidence: 0.9,
      },
    ]);
    // The reviewer that produced the verdict joins the ones already on the annotation.
    expect(annotation['reviewers']).toEqual(['reviewer-a', 'rewriter-a']);
    expect(run(layout, '--check').status).toBe(0);
  });

  it('refuses a reviewer file that declares no reviewerKind', () => {
    const layout = makeCorpus({ reviewer: 'reviewer-a', verdicts: { demo: [verdictRow] } });

    const result = run(layout, '--check');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('reviewer-a.json: reviewerKind must be "human" or "agent"');
  });

  it('refuses a reviewerKind outside the two it records', () => {
    const layout = makeCorpus({
      reviewer: 'reviewer-a',
      reviewerKind: 'reviewer-a',
      verdicts: { demo: [verdictRow] },
    });

    const result = run(layout, '--check');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('reviewerKind must be "human" or "agent"');
  });

  it('reports a committed annotation that was edited away from the verdicts', () => {
    const layout = makeCorpus({
      reviewer: 'reviewer-a',
      reviewerKind: 'agent',
      verdicts: { demo: [verdictRow] },
    });
    expect(run(layout).status).toBe(0);

    // The edit `--check` used to miss entirely: the verdicts still bind, the annotation now lies.
    const path = join(layout.fixtures, 'annotations', 'demo.json');
    const annotation = JSON.parse(readFileSync(path, 'utf8'));
    annotation.candidateAdjudications[0].reviewerKind = 'human';
    writeFileSync(path, JSON.stringify(annotation, null, 2));

    const result = run(layout, '--check');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'annotation reviewerKind is "human", the verdicts give "agent"',
    );
  });

  it('reports an adjudication left behind after its candidate disappeared', () => {
    const layout = makeCorpus({
      reviewer: 'reviewer-a',
      reviewerKind: 'agent',
      verdicts: { demo: [verdictRow] },
    });
    expect(run(layout).status).toBe(0);

    // A rule change that moves a span leaves the old record in place — the #54 failure, where ten
    // records across five annotations described passages that no longer existed.
    const path = join(layout.fixtures, 'annotations', 'demo.json');
    const annotation = JSON.parse(readFileSync(path, 'utf8'));
    annotation.candidateAdjudications[0].span = { start: 900, end: 904 };
    writeFileSync(path, JSON.stringify(annotation, null, 2));

    const result = run(layout, '--check');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'annotation holds an adjudication at ambiguous-pronoun-candidate@900-904 that no verdict produces',
    );
  });
});
