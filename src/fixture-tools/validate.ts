import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { annotationSchema } from './annotation-schema.js';
import { extractProtectedLiterals } from './literals.js';
import {
  fixtureManifestSchema,
  provenanceLockSchema,
  type FixtureEntry,
} from './manifest-schema.js';

/**
 * Fixture provenance and corpus-integrity validation.
 *
 * Every checkable fact is re-derived from disk rather than trusted from the manifest, so a
 * fabricated or drifted entry fails. What is checked:
 *
 * - the manifest and the provenance lock satisfy their schemas;
 * - each `originalSha256` matches the committed file;
 * - each `provenanceKey` resolves to a lock record with a 2xx status and non-zero bytes;
 * - no share-alike or copyleft licence is present, and licence evidence exists;
 * - a CC-BY source propagates attribution into its adaptation's licence;
 * - category minimums, split sizes, and the absence of split leakage;
 * - protected literals are byte-identical between an original and its rewritten counterpart;
 * - annotations parse, agree with the manifest, and quote text that actually exists.
 */

export interface ValidationReport {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly notes: readonly string[];
  readonly summary: string;
}

/** Share-alike and copyleft licences propagate obligations to adaptations, so they are excluded. */
const FORBIDDEN_LICENCE =
  /(share-?alike|(?:^|[^A-Za-z])SA(?:[^A-Za-z]|$)|GFDL|(?:^|[^A-Za-z])GPL|LGPL|AGPL|all rights reserved)/i;

const REQUIRED_CATEGORIES = [
  'installation',
  'maintenance',
  'troubleshooting',
  'safety-warning',
  'descriptive',
  'api-configuration',
  'cli-reference',
  'structured-content',
  'hard-negative',
] as const;

const MIN_FIXTURES = 15;
const MIN_ORIGINAL_CHARS = 300;
const MAX_ORIGINAL_CHARS = 2400;

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function validateFixtureCorpus(fixturesDir: string): ValidationReport {
  const failures: string[] = [];
  const notes: string[] = [];
  const check = (condition: boolean, message: string): void => {
    if (!condition) failures.push(message);
  };

  const manifestPath = join(fixturesDir, 'manifest.json');
  const lockPath = join(fixturesDir, 'provenance.lock.json');

  if (!existsSync(manifestPath)) {
    return { ok: false, failures: [`${manifestPath} is missing`], notes, summary: 'no manifest' };
  }
  if (!existsSync(lockPath)) {
    return {
      ok: false,
      failures: [`${lockPath} is missing; run "npm run fixtures:fetch"`],
      notes,
      summary: 'no provenance lock',
    };
  }

  const manifestParsed = fixtureManifestSchema.safeParse(
    JSON.parse(readFileSync(manifestPath, 'utf8')),
  );
  if (!manifestParsed.success) {
    return {
      ok: false,
      failures: manifestParsed.error.issues.map(
        (i) => `manifest.json ${i.path.join('.') || '<root>'}: ${i.message}`,
      ),
      notes,
      summary: 'manifest schema violation',
    };
  }
  const lockParsed = provenanceLockSchema.safeParse(JSON.parse(readFileSync(lockPath, 'utf8')));
  if (!lockParsed.success) {
    return {
      ok: false,
      failures: lockParsed.error.issues.map(
        (i) => `provenance.lock.json ${i.path.join('.') || '<root>'}: ${i.message}`,
      ),
      notes,
      summary: 'provenance schema violation',
    };
  }

  const manifest = manifestParsed.data;
  const lock = lockParsed.data;
  const ids = new Set<string>();
  let withCounterpart = 0;

  for (const fixture of manifest.fixtures) {
    const label = `fixture "${fixture.id}"`;
    check(!ids.has(fixture.id), `${label}: duplicate id`);
    ids.add(fixture.id);

    const originalPath = join(fixturesDir, fixture.originalPath);
    if (!existsSync(originalPath)) {
      failures.push(`${label}: originalPath ${fixture.originalPath} does not exist`);
      continue;
    }
    const actualSha = sha256(originalPath);
    check(
      actualSha === fixture.originalSha256,
      `${label}: originalSha256 mismatch — manifest ${fixture.originalSha256}, file ${actualSha}`,
    );
    const original = readFileSync(originalPath, 'utf8');
    check(
      original.length >= MIN_ORIGINAL_CHARS && original.length <= MAX_ORIGINAL_CHARS,
      `${label}: original is ${original.length} characters, expected ${MIN_ORIGINAL_CHARS}–${MAX_ORIGINAL_CHARS}`,
    );

    const record = lock.records[fixture.provenanceKey];
    if (record === undefined) {
      failures.push(`${label}: provenanceKey "${fixture.provenanceKey}" is not in the lock file`);
    } else {
      check(
        record.httpStatus >= 200 && record.httpStatus < 300,
        `${label}: provenance record status is ${record.httpStatus}`,
      );
      check(record.bytes > 0, `${label}: provenance record reports 0 bytes`);
      const base = fixture.sourceUrl.split('#')[0] ?? fixture.sourceUrl;
      check(
        record.url === fixture.sourceUrl ||
          record.url.startsWith(base) ||
          base.startsWith(record.url),
        `${label}: sourceUrl ${fixture.sourceUrl} does not correspond to the fetched url ${record.url}`,
      );
    }

    check(
      !FORBIDDEN_LICENCE.test(fixture.licence),
      `${label}: licence "${fixture.licence}" is share-alike or copyleft and may not be redistributed here`,
    );
    check(
      !FORBIDDEN_LICENCE.test(fixture.derivativeLicence),
      `${label}: derivativeLicence "${fixture.derivativeLicence}" is share-alike or copyleft`,
    );
    check(
      fixture.licenceEvidence.quote.trim().length >= 10,
      `${label}: licence evidence quote is too short to be evidence`,
    );
    if (/^CC-?BY(?!-?SA)/i.test(fixture.licence)) {
      check(
        /CC-?BY/i.test(fixture.derivativeLicence),
        `${label}: source is ${fixture.licence}, so derivativeLicence must also carry attribution, got "${fixture.derivativeLicence}"`,
      );
    }

    const compliantPath = join(fixturesDir, fixture.compliantPath);
    const annotationPath = join(fixturesDir, fixture.annotationPath);
    if (!existsSync(compliantPath)) {
      notes.push(`${label}: no rewritten counterpart yet (${fixture.compliantPath})`);
      continue;
    }
    withCounterpart += 1;
    check(
      existsSync(annotationPath),
      `${label}: has a rewritten counterpart but no annotation at ${fixture.annotationPath}`,
    );

    const compliant = readFileSync(compliantPath, 'utf8');
    for (const literal of extractProtectedLiterals(original)) {
      check(
        compliant.includes(literal),
        `${label}: protected literal ${JSON.stringify(literal)} is missing from the rewritten counterpart`,
      );
    }

    if (existsSync(annotationPath)) {
      const parsed = annotationSchema.safeParse(JSON.parse(readFileSync(annotationPath, 'utf8')));
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          failures.push(
            `${label}: annotation invalid — ${issue.path.join('.') || '<root>'}: ${issue.message}`,
          );
        }
      } else {
        const annotation = parsed.data;
        check(annotation.fixtureId === fixture.id, `${label}: annotation fixtureId mismatch`);
        check(
          annotation.split === fixture.split,
          `${label}: annotation split "${annotation.split}" disagrees with the manifest "${fixture.split}"`,
        );
        check(annotation.changes.length > 0, `${label}: annotation records no changes`);
        for (const change of annotation.changes) {
          const where = `${label}/${change.passageId}`;
          check(
            original.includes(change.originalText),
            `${where}: originalText does not appear in the original fixture`,
          );
          check(
            compliant.includes(change.rewrittenText),
            `${where}: rewrittenText does not appear in the rewritten fixture`,
          );
          for (const span of change.originalSpans) {
            check(
              span.end > span.start && span.end <= original.length,
              `${where}: original span ${span.start}-${span.end} is not inside the original`,
            );
            check(
              original.slice(span.start, span.end).length > 0,
              `${where}: original span ${span.start}-${span.end} is empty`,
            );
          }
          for (const expected of change.expectedDiagnostics) {
            check(
              original.includes(expected.quote),
              `${where}: expected-diagnostic quote ${JSON.stringify(expected.quote)} does not appear in the original`,
            );
          }
          for (const literal of annotation.protectedLiterals) {
            check(
              original.includes(literal) && compliant.includes(literal),
              `${label}: declared protected literal ${JSON.stringify(literal)} is not present in both versions`,
            );
          }
        }
      }
    }
  }

  const originalDir = join(fixturesDir, 'original');
  if (existsSync(originalDir)) {
    const orphans = readdirSync(originalDir).filter(
      (file) =>
        file.endsWith('.md') && !manifest.fixtures.some((f) => f.originalPath.endsWith(`/${file}`)),
    );
    check(
      orphans.length === 0,
      `files in fixtures/original are not listed in the manifest: ${orphans.join(', ')}`,
    );
  }

  const byCategory = new Map<string, number>();
  for (const fixture of manifest.fixtures) {
    byCategory.set(fixture.category, (byCategory.get(fixture.category) ?? 0) + 1);
  }
  for (const category of REQUIRED_CATEGORIES) {
    check(
      (byCategory.get(category) ?? 0) >= 2,
      `category "${category}" has ${byCategory.get(category) ?? 0} fixtures; at least 2 are required`,
    );
  }
  check(
    manifest.fixtures.length >= MIN_FIXTURES,
    `the corpus has ${manifest.fixtures.length} fixtures; at least ${MIN_FIXTURES} are required`,
  );

  const dev = manifest.fixtures.filter((f) => f.split === 'dev');
  const heldout = manifest.fixtures.filter((f) => f.split === 'heldout');
  check(dev.length >= 1 && heldout.length >= 1, 'both dev and heldout splits must be non-empty');
  check(
    heldout.length >= Math.floor(manifest.fixtures.length * 0.25),
    `heldout split has ${heldout.length} of ${manifest.fixtures.length}; at least 25% is required so evaluation numbers mean something`,
  );

  const bySha = new Map<string, FixtureEntry[]>();
  for (const fixture of manifest.fixtures) {
    const list = bySha.get(fixture.originalSha256) ?? [];
    list.push(fixture);
    bySha.set(fixture.originalSha256, list);
  }
  for (const [sha, group] of bySha) {
    if (group.length < 2) continue;
    check(
      new Set(group.map((f) => f.split)).size === 1,
      `identical fixture content (${sha.slice(0, 12)}) appears in both splits: ${group
        .map((f) => f.id)
        .join(', ')} — this leaks the evaluation set`,
    );
  }

  check(
    manifest.licenceStatement.length >= 40,
    'manifest.licenceStatement must explain why redistribution is permitted',
  );
  check(existsSync(join(fixturesDir, 'LICENSES.md')), 'fixtures/LICENSES.md is missing');

  return {
    ok: failures.length === 0,
    failures,
    notes,
    summary:
      `${manifest.fixtures.length} fixtures, ${withCounterpart} with a rewritten counterpart, ` +
      `${dev.length} dev / ${heldout.length} heldout, ${byCategory.size} categories`,
  };
}
