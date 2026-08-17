import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `scripts/ci/check-annotation-provenance.sh` is the gate that makes a forged corpus fail CI, and
 * nothing tested it. An independent review stubbed out each of its checks in turn — the digest
 * comparison, the reviewer-set comparison, the undeclared-fixture and missing-fixture loops, the
 * derived-`reviewers` check, the totals loop, and finally the exit code itself — and the script,
 * the full suite and `validate-fixtures.mjs` stayed green through every one of them. Seven
 * survivors out of eight attempts, on a file whose entire job is to refuse things.
 *
 * These cases run the real script against a synthetic corpus, via the `ANNOTATIONS_DIR` and
 * `EXPECTED_*` overrides it grew for exactly this purpose. Each one is a mutant that survived.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const script = 'scripts/ci/check-annotation-provenance.sh';

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

const adjudication = {
  passageId: 'ambiguous-pronoun-candidate:s1:10',
  ruleId: 'ambiguous-pronoun-candidate',
  evaluatorId: 'pronoun-antecedent-ambiguity',
  quote: 'them',
  span: { start: 10, end: 14 },
  verdict: 'non-violation',
  reason: 'The pronoun has exactly one plural antecedent.',
  reviewer: 'reviewer-a',
  reviewerKind: 'agent',
  reviewerConfidence: 0.9,
};

/** The same canonicalisation the script uses: keys sorted, array order kept. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    const source: Record<string, unknown> = { ...value };
    return Object.fromEntries(
      Object.keys(source)
        .toSorted()
        .map((k) => [k, canonical(source[k])]),
    );
  }
  return value;
}

const digestOf = (annotation: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonical(annotation)))
    .digest('hex');

const roots: string[] = [];

interface Corpus {
  readonly dir: string;
  readonly env: Record<string, string>;
}

/**
 * One annotation on disk, plus declarations that describe it exactly. Every case below breaks one
 * side of that agreement and expects the script to notice.
 */
function makeCorpus(overrides: Partial<Record<string, string>> = {}, raw?: string): Corpus {
  const root = mkdtempSync(join(tmpdir(), 'ste-ai-provenance-'));
  roots.push(root);
  const dir = join(root, 'annotations');
  mkdirSync(dir);

  const annotation = {
    fixtureId: 'demo',
    reviewers: ['reviewer-a', 'rewriter-a'],
    changes: [change],
    candidateAdjudications: [adjudication],
  };
  writeFileSync(join(dir, 'demo.json'), raw ?? `${JSON.stringify(annotation, null, 2)}\n`);

  return {
    dir,
    env: {
      ANNOTATIONS_DIR: dir,
      EXPECTED_ADJUDICATIONS: '1',
      EXPECTED_ADJUDICATION_REVIEWERS: 'reviewer-a=1',
      EXPECTED_CHANGES: '1',
      EXPECTED_CHANGE_REVIEWERS: 'rewriter-a=1',
      EXPECTED_KINDS: 'agent=2',
      EXPECTED_PER_FIXTURE: `demo=reviewer-a+rewriter-a|${digestOf(annotation)}`,
      ...overrides,
    },
  };
}

function run(corpus: Corpus) {
  const result = spawnSync('bash', [script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...corpus.env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Rewrite the annotation on disk, leaving the declarations describing the old one. */
function tamper(corpus: Corpus, mutate: (annotation: Record<string, unknown>) => void): void {
  const path = join(corpus.dir, 'demo.json');
  const annotation = {
    fixtureId: 'demo',
    reviewers: ['reviewer-a', 'rewriter-a'],
    changes: [change],
    candidateAdjudications: [adjudication],
  };
  mutate(annotation);
  writeFileSync(path, `${JSON.stringify(annotation, null, 2)}\n`);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('check-annotation-provenance', () => {
  it('passes a corpus its declarations describe exactly', () => {
    const result = run(makeCorpus());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 adjudications and 1 rewrites');
  });

  it('refuses an edit to a record the digest covers', () => {
    const corpus = makeCorpus();
    tamper(corpus, (annotation) => {
      annotation['changes'] = [{ ...change, status: 'disputed' }];
    });

    const result = run(corpus);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('demo: annotation content changed.');
  });

  it('refuses an edit to an adjudication verdict, which the binding does not constrain', () => {
    const corpus = makeCorpus();
    tamper(corpus, (annotation) => {
      annotation['candidateAdjudications'] = [{ ...adjudication, verdict: 'violation' }];
    });

    const result = run(corpus);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('demo: annotation content changed.');
  });

  it('accepts a reformat, because the digest sorts keys before hashing', () => {
    const corpus = makeCorpus();
    const reordered = {
      candidateAdjudications: [adjudication],
      changes: [change],
      reviewers: ['reviewer-a', 'rewriter-a'],
      fixtureId: 'demo',
    };
    writeFileSync(join(corpus.dir, 'demo.json'), `${JSON.stringify(reordered, null, 4)}\n`);

    expect(run(corpus).status).toBe(0);
  });

  it('refuses a duplicate key, as a message rather than a stack trace', () => {
    const raw = [
      '{',
      '  "fixtureId": "demo",',
      '  "reviewers": ["reviewer-a", "rewriter-a"],',
      `  "changes": [${JSON.stringify({ ...change, reviewer: 'a-human', reviewerKind: 'human' })}],`,
      `  "changes": [${JSON.stringify(change)}],`,
      `  "candidateAdjudications": [${JSON.stringify(adjudication)}]`,
      '}',
      '',
    ].join('\n');
    const corpus = makeCorpus({}, raw);

    const result = run(corpus);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('duplicate key "changes"');
    expect(result.stderr).not.toContain('at JSON.parse');
  });

  it('refuses a fixture whose reviewer set is not the one declared', () => {
    const corpus = makeCorpus();
    tamper(corpus, (annotation) => {
      annotation['reviewers'] = ['reviewer-a', 'rewriter-b'];
      annotation['changes'] = [{ ...change, reviewer: 'rewriter-b' }];
    });

    const result = run(corpus);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected reviewers reviewer-a+rewriter-a');
  });

  it('refuses a fixture present in the corpus but declared nowhere', () => {
    const corpus = makeCorpus();
    writeFileSync(
      join(corpus.dir, 'extra.json'),
      `${JSON.stringify({ fixtureId: 'extra', reviewers: ['rewriter-a'], changes: [change] }, null, 2)}\n`,
    );

    const result = run(corpus);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('extra: no expected reviewer set is declared for this fixture');
  });

  it('refuses a fixture declared here but missing from the corpus', () => {
    const corpus = makeCorpus({
      EXPECTED_PER_FIXTURE: `${makeCorpus().env['EXPECTED_PER_FIXTURE']}\nvanished=rewriter-a|${'0'.repeat(64)}`,
    });

    const result = run(corpus);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('vanished: declared here, but no such annotation was read');
  });

  it('refuses a reviewers array that is not the set its records carry', () => {
    const corpus = makeCorpus();
    tamper(corpus, (annotation) => {
      annotation['reviewers'] = ['reviewer-a', 'rewriter-a', 'rewriter-b'];
    });

    const result = run(corpus);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not the set its records carry');
  });

  it('refuses a record count that does not match the declared total', () => {
    const result = run(makeCorpus({ EXPECTED_CHANGES: '2' }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('rewrite records: expected 2, found 1');
  });

  it('refuses a reviewer kind tally that does not match', () => {
    const result = run(makeCorpus({ EXPECTED_KINDS: 'agent=1,human=1' }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('reviewer kinds: expected agent=1,human=1, found agent=2');
  });

  it('refuses a per-run split that does not match', () => {
    const result = run(makeCorpus({ EXPECTED_ADJUDICATION_REVIEWERS: 'reviewer-b=1' }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('adjudication reviewers: expected reviewer-b=1');
  });
});
