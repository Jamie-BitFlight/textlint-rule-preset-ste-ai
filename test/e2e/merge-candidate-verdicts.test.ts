import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `scripts/merge-candidate-verdicts.mjs` is the only thing that writes the ground truth the
 * semantic evaluators are scored against, and until this file existed nothing exercised it.
 *
 * The cases below are chosen by mutation: each one exists because deleting a specific line of the
 * script leaves every other gate in the project green. The guarantees they hold down are that
 * `reviewerKind` is required on input and stamped on output, that `--check` compares against the
 * committed annotations rather than stopping at "the verdicts bind", that `reviewers` is derived
 * from the records instead of folded together with what is already in the file, and that the write
 * path neither leaves a stale record behind nor rewrites a file that already holds the right bytes.
 *
 * The corpus is not used here. These are properties of the tool, and asserting them against the
 * real 105-record corpus would make them fail for reasons that have nothing to do with the tool.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const script = 'scripts/merge-candidate-verdicts.mjs';

/** One candidate, and the verdict that binds to it. Enough for the tool; nothing more. */
const candidate = {
  passageId: 'ambiguous-pronoun-candidate:s1:10',
  ruleId: 'ambiguous-pronoun-candidate',
  evaluatorId: 'pronoun-antecedent-ambiguity',
  quote: 'them',
  span: { start: 10, end: 14 },
};

const verdictRow = {
  ...candidate,
  verdict: 'non-violation',
  reason: 'The pronoun has exactly one plural antecedent in the preceding clause.',
  reviewerConfidence: 0.9,
};

/** A rewrite record, so the fixture has both populations the `reviewers` array is derived from. */
const change = {
  passageId: 'demo-p1',
  originalText: 'utilise the utility',
  rewrittenText: 'use the utility',
  ruleIds: ['unapproved-vocabulary'],
  originalSpans: [{ start: 0, end: 7 }],
  expectedDiagnostics: [],
  reason: 'Approved alternative, no change of meaning.',
  semanticInvariants: ['the utility being referred to'],
  unresolved: [],
  status: 'accepted',
  reviewer: 'rewriter-a',
  reviewerKind: 'agent',
  reviewerConfidence: 0.9,
};

interface Layout {
  readonly verdicts: string;
  readonly packets: string;
  readonly fixtures: string;
}

interface Options {
  /** A second manifest fixture with no packet and no verdicts, carrying this annotation. */
  readonly orphanedAnnotation?: Record<string, unknown>;
}

const roots: string[] = [];

/**
 * A three-directory corpus of one fixture, shaped the way the real one is: a packet holding the
 * candidate, a verdict file holding the judgement, and an annotation the merge writes into.
 */
function makeCorpus(reviewerDoc: Record<string, unknown>, options: Options = {}): Layout {
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

  const manifest = [{ id: 'demo', annotationPath: 'annotations/demo.json' }];
  writeFileSync(
    join(fixtures, 'annotations', 'demo.json'),
    JSON.stringify({ fixtureId: 'demo', reviewers: ['rewriter-a'], changes: [change] }),
  );
  if (options.orphanedAnnotation !== undefined) {
    manifest.push({ id: 'gone', annotationPath: 'annotations/gone.json' });
    writeFileSync(
      join(fixtures, 'annotations', 'gone.json'),
      `${JSON.stringify(options.orphanedAnnotation, null, 2)}\n`,
    );
  }
  writeFileSync(join(fixtures, 'manifest.json'), JSON.stringify({ fixtures: manifest }));
  return { verdicts, packets, fixtures };
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

const annotationPath = (layout: Layout, id = 'demo') =>
  join(layout.fixtures, 'annotations', `${id}.json`);

function readAnnotation(layout: Layout, id = 'demo'): Record<string, unknown> {
  return JSON.parse(readFileSync(annotationPath(layout, id), 'utf8'));
}

/** The parts of a parsed annotation these tests edit. `JSON.parse` gives no types of its own. */
interface MutableAnnotation {
  reviewers: string[];
  /**
   * Deliberately not `Record<string, unknown>[]`. Two cases below put a shape here that a valid
   * annotation never holds — an object instead of an array, and an array holding `null` — because
   * both reach the comparison and used to abort the run on a raw `TypeError`. Typing the field as
   * what a *file* can contain, rather than what a correct file contains, lets the tests write those
   * without a cast.
   */
  candidateAdjudications: unknown;
}

/** The first adjudication, or a failure that names the reason rather than an index error. */
function firstAdjudication(annotation: MutableAnnotation): Record<string, unknown> {
  const records = annotation.candidateAdjudications;
  if (!Array.isArray(records)) throw new Error('candidateAdjudications is not an array');
  const [first] = records;
  if (first === undefined || typeof first !== 'object' || first === null) {
    throw new Error('the annotation has no adjudication to edit');
  }
  return first;
}

/** Edit a committed annotation the way a person with an editor would. */
function editAnnotation(
  layout: Layout,
  mutate: (annotation: MutableAnnotation) => void,
  id = 'demo',
): void {
  const path = annotationPath(layout, id);
  const annotation = JSON.parse(readFileSync(path, 'utf8'));
  mutate(annotation);
  writeFileSync(path, `${JSON.stringify(annotation, null, 2)}\n`);
}

const agentVerdicts = { reviewer: 'reviewer-a', reviewerKind: 'agent', verdicts: { demo: [] } };
const withRow = (doc: Record<string, unknown>) => ({ ...doc, verdicts: { demo: [verdictRow] } });

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('merge-candidate-verdicts', () => {
  describe('what it writes', () => {
    it('stamps the declared reviewerKind onto every record', () => {
      const layout = makeCorpus(withRow(agentVerdicts));

      expect(run(layout).status).toBe(0);

      expect(readAnnotation(layout)['candidateAdjudications']).toEqual([
        {
          ...candidate,
          verdict: 'non-violation',
          reason: verdictRow.reason,
          reviewer: 'reviewer-a',
          reviewerKind: 'agent',
          reviewerConfidence: 0.9,
        },
      ]);
      expect(run(layout, '--check').status).toBe(0);
    });

    it('stamps human when that is what the reviewer file declares', () => {
      const layout = makeCorpus(withRow({ ...agentVerdicts, reviewerKind: 'human' }));

      expect(run(layout).status).toBe(0);

      expect(readAnnotation(layout)['candidateAdjudications']).toEqual([
        expect.objectContaining({ reviewerKind: 'human', reviewer: 'reviewer-a' }),
      ]);
    });

    it('derives reviewers from both record populations', () => {
      const layout = makeCorpus(withRow(agentVerdicts));

      expect(run(layout).status).toBe(0);

      // `reviewer-a` judged a candidate; `rewriter-a` wrote the rewrite. Neither is taken from what
      // the file already said.
      expect(readAnnotation(layout)['reviewers']).toEqual(['reviewer-a', 'rewriter-a']);
    });

    it('leaves a file that already holds the right bytes untouched', () => {
      const layout = makeCorpus(withRow(agentVerdicts));
      expect(run(layout).status).toBe(0);
      const before = readFileSync(annotationPath(layout), 'utf8');

      const result = run(layout);

      expect(readFileSync(annotationPath(layout), 'utf8')).toBe(before);
      expect(result.stderr).toContain('written to 0 annotation files');
    });

    it('repairs drifted records even when the reviewer set already matches', () => {
      // The guard that skips an unchanged file compares two things. Deleting either half leaves the
      // suite green unless both directions are asserted, and this is the half that does damage: a
      // record edited without touching `reviewers` would never be repaired, so `--check` would go on
      // failing with no way to fix it short of hand-editing.
      const layout = makeCorpus(withRow(agentVerdicts));
      expect(run(layout).status).toBe(0);
      editAnnotation(layout, (a) => {
        firstAdjudication(a)['reason'] = 'rewritten by hand, reviewers untouched';
      });

      expect(run(layout).status).toBe(0);

      expect(readAnnotation(layout)['candidateAdjudications']).toEqual([
        expect.objectContaining({ reason: verdictRow.reason }),
      ]);
      expect(run(layout, '--check').status).toBe(0);
    });

    it('repairs a reviewer set that drifted while the records did not', () => {
      const layout = makeCorpus(withRow(agentVerdicts));
      expect(run(layout).status).toBe(0);
      editAnnotation(layout, (a) => {
        a.reviewers = ['reviewer-a'];
      });

      expect(run(layout).status).toBe(0);

      expect(readAnnotation(layout)['reviewers']).toEqual(['reviewer-a', 'rewriter-a']);
    });

    it('empties a fixture whose candidates have all disappeared', () => {
      // The #54 failure: a rule change moves a span, the candidate is gone, and the verdict written
      // about it stays in the annotation describing a passage that no longer exists.
      const layout = makeCorpus(withRow(agentVerdicts), {
        orphanedAnnotation: {
          fixtureId: 'gone',
          reviewers: ['reviewer-a', 'rewriter-a'],
          changes: [change],
          candidateAdjudications: [{ ...candidate, verdict: 'violation', reviewer: 'reviewer-a' }],
        },
      });

      expect(run(layout).status).toBe(0);

      const annotation = readAnnotation(layout, 'gone');
      expect(annotation['candidateAdjudications']).toEqual([]);
      expect(annotation['reviewers']).toEqual(['rewriter-a']);
    });
  });

  describe('what it refuses', () => {
    it('refuses a reviewer file that declares no reviewerKind', () => {
      const layout = makeCorpus({ reviewer: 'reviewer-a', verdicts: { demo: [verdictRow] } });

      const result = run(layout, '--check');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('reviewer-a.json: reviewerKind must be "human" or "agent"');
    });

    it('refuses a reviewerKind outside the two it records', () => {
      const layout = makeCorpus(withRow({ ...agentVerdicts, reviewerKind: 'reviewer-a' }));

      const result = run(layout, '--check');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('reviewerKind must be "human" or "agent"');
    });
  });

  describe('what --check catches in a committed annotation', () => {
    const checked = (mutate: (annotation: MutableAnnotation) => void) => {
      const layout = makeCorpus(withRow(agentVerdicts));
      expect(run(layout).status).toBe(0);
      editAnnotation(layout, mutate);
      return run(layout, '--check');
    };

    it('a field edited away from the verdicts', () => {
      const result = checked((a) => {
        firstAdjudication(a)['reviewerKind'] = 'human';
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'annotation reviewerKind is "human", the verdicts give "agent"',
      );
    });

    it('a field added by hand, which no write would keep', () => {
      const result = checked((a) => {
        firstAdjudication(a)['note'] = 'actually disputed';
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('annotation note is "actually disputed"');
    });

    it('a field deleted by hand, the other direction of the same comparison', () => {
      const result = checked((a) => {
        delete firstAdjudication(a)['reviewerConfidence'];
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'annotation reviewerConfidence is undefined, the verdicts give 0.9',
      );
    });

    it('candidateAdjudications that is not an array at all', () => {
      const layout = makeCorpus(withRow(agentVerdicts));
      expect(run(layout).status).toBe(0);
      editAnnotation(layout, (a) => {
        // An object, so the `?? []` fallback does not fire and every array method below it throws.
        a.candidateAdjudications = {};
      });

      const result = run(layout, '--check');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('demo: candidateAdjudications is not an array');
      expect(result.stderr).not.toContain('TypeError');
    });

    it('an adjudication that is not an object, rather than crashing on it', () => {
      // `[null]` is valid JSON and passes `Array.isArray`, so it reaches the comparison. Before the
      // guard it aborted the run on a raw TypeError, which left every later fixture unchecked.
      const result = checked((a) => {
        a.candidateAdjudications = [null];
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('demo: 1 adjudication(s) are not objects');
      expect(result.stderr).not.toContain('TypeError');
    });

    it('an adjudication left behind after its candidate moved', () => {
      const result = checked((a) => {
        firstAdjudication(a)['span'] = { start: 900, end: 904 };
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'annotation holds an adjudication at ambiguous-pronoun-candidate@900-904 that no verdict produces',
      );
    });

    it('the right adjudications in the wrong order', () => {
      const layout = makeCorpus({
        ...agentVerdicts,
        verdicts: {
          demo: [verdictRow, { ...verdictRow, span: { start: 40, end: 44 }, quote: 'they' }],
        },
      });
      writeFileSync(
        join(layout.packets, 'demo.json'),
        JSON.stringify({
          fixtureId: 'demo',
          candidates: [
            candidate,
            { ...candidate, span: { start: 40, end: 44 }, quote: 'they', passageId: 'p2' },
          ],
        }),
      );
      expect(run(layout).status).toBe(0);
      editAnnotation(layout, (a) => {
        if (!Array.isArray(a.candidateAdjudications)) throw new Error('not an array');
        a.candidateAdjudications.reverse();
      });

      const result = run(layout, '--check');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('the right adjudications in the wrong order');
    });

    it('a reviewer name added to the array that no record accounts for', () => {
      // Inserted in sorted position on purpose: the previous implementation only ever noticed a
      // name appended out of order, so it was checking alphabetisation rather than provenance.
      const result = checked((a) => {
        a.reviewers = ['dr-fabricated', 'reviewer-a', 'rewriter-a'];
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'annotation reviewers are ["dr-fabricated","reviewer-a","rewriter-a"], the records give ["reviewer-a","rewriter-a"]',
      );
    });

    it('a reviewer name removed from the array', () => {
      const result = checked((a) => {
        a.reviewers = ['reviewer-a'];
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('the records give ["reviewer-a","rewriter-a"]');
    });

    it('a duplicated record, named as a count rather than as an ordering problem', () => {
      const result = checked((a) => {
        const records = a.candidateAdjudications;
        if (!Array.isArray(records)) throw new Error('not an array');
        records.push({ ...firstAdjudication(a) });
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('annotation holds 2 adjudication(s), the verdicts give 1');
    });

    it('an unreadable annotation, as a message rather than a stack trace', () => {
      const layout = makeCorpus(withRow(agentVerdicts));
      expect(run(layout).status).toBe(0);
      writeFileSync(annotationPath(layout), '{ not json');

      const result = run(layout, '--check');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('demo: cannot read annotations/demo.json:');
      expect(result.stderr).not.toContain('at JSON.parse');
    });
  });
});
