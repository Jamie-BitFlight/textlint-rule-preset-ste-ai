#!/usr/bin/env node
/**
 * Merge reviewer verdicts on heuristic candidates into the fixture adjudication records.
 *
 * Input is a directory of reviewer files, each shaped:
 *
 *   { "reviewer": "<id>", "verdicts": { "<fixtureId>": [ { passageId, ruleId, evaluatorId,
 *     quote, span, verdict, reason, reviewerConfidence }, ... ] } }
 *
 * Every verdict is checked against the candidate packet it claims to be about before it is
 * written: passageId must exist, and ruleId, evaluatorId, quote and span must match byte for byte.
 * A verdict that does not bind to a real passage is not ground truth, it is an assertion about
 * nothing, so the merge refuses rather than writing it.
 *
 * Usage:
 *   node scripts/merge-candidate-verdicts.mjs --verdicts DIR --packets DIR [--check]
 *
 * `--check` validates and reports without writing, which is what CI runs.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const verdictsDir = resolve(flag('--verdicts', 'fixtures/verdicts'));
const packetsDir = resolve(flag('--packets', 'fixtures/packets'));
const fixturesDir = resolve(flag('--fixtures', 'fixtures'));
const checkOnly = args.includes('--check');

const jsonFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith('.json'));

const packets = new Map();
for (const file of jsonFiles(packetsDir)) {
  const packet = JSON.parse(readFileSync(join(packetsDir, file), 'utf8'));
  packets.set(packet.fixtureId, new Map(packet.candidates.map((c) => [c.passageId, c])));
}

const problems = [];
/** fixtureId -> passageId -> adjudication record */
const merged = new Map();

for (const file of jsonFiles(verdictsDir).sort()) {
  const doc = JSON.parse(readFileSync(join(verdictsDir, file), 'utf8'));
  const reviewer = doc.reviewer;
  if (typeof reviewer !== 'string' || reviewer.length === 0) {
    problems.push(`${file}: missing reviewer id`);
    continue;
  }
  for (const [fixtureId, rows] of Object.entries(doc.verdicts ?? {})) {
    const candidates = packets.get(fixtureId);
    if (candidates === undefined) {
      problems.push(`${reviewer}: no candidate packet for fixture "${fixtureId}"`);
      continue;
    }
    for (const row of rows) {
      const candidate = candidates.get(row.passageId);
      if (candidate === undefined) {
        problems.push(`${reviewer}/${fixtureId}: no candidate "${row.passageId}"`);
        continue;
      }
      for (const key of ['ruleId', 'evaluatorId', 'quote']) {
        if (row[key] !== candidate[key]) {
          problems.push(`${reviewer}/${fixtureId}/${row.passageId}: ${key} does not match packet`);
        }
      }
      if (row.span?.start !== candidate.span.start || row.span?.end !== candidate.span.end) {
        problems.push(`${reviewer}/${fixtureId}/${row.passageId}: span does not match packet`);
      }
      const byFixture = merged.get(fixtureId) ?? new Map();
      if (byFixture.has(row.passageId)) {
        problems.push(`${reviewer}/${fixtureId}: duplicate verdict for "${row.passageId}"`);
        continue;
      }
      byFixture.set(row.passageId, {
        passageId: row.passageId,
        ruleId: row.ruleId,
        evaluatorId: row.evaluatorId,
        quote: row.quote,
        span: { start: row.span.start, end: row.span.end },
        verdict: row.verdict,
        reason: row.reason,
        reviewer,
        reviewerConfidence: row.reviewerConfidence,
      });
      merged.set(fixtureId, byFixture);
    }
  }
}

for (const [fixtureId, candidates] of packets) {
  const judged = merged.get(fixtureId) ?? new Map();
  for (const passageId of candidates.keys()) {
    if (!judged.has(passageId)) {
      problems.push(`${fixtureId}: candidate "${passageId}" has no verdict`);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  process.stderr.write(`\n${problems.length} problem(s); nothing written.\n`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(fixturesDir, 'manifest.json'), 'utf8'));
let written = 0;
let total = 0;
for (const fixture of manifest.fixtures) {
  const judged = merged.get(fixture.id);
  if (judged === undefined) continue;
  // Sort by span so the file is stable regardless of which reviewer produced which row.
  const records = [...judged.values()].sort(
    (a, b) =>
      a.span.start - b.span.start || a.span.end - b.span.end || a.ruleId.localeCompare(b.ruleId),
  );
  total += records.length;
  if (checkOnly) continue;
  const path = join(fixturesDir, fixture.annotationPath);
  const annotation = JSON.parse(readFileSync(path, 'utf8'));
  annotation.candidateAdjudications = records;
  const reviewers = new Set([...(annotation.reviewers ?? []), ...records.map((r) => r.reviewer)]);
  annotation.reviewers = [...reviewers].sort();
  writeFileSync(path, `${JSON.stringify(annotation, null, 2)}\n`);
  written += 1;
}

process.stderr.write(
  checkOnly
    ? `ok: ${total} verdicts bind to ${merged.size} fixtures with no problems\n`
    : `${total} verdicts written to ${written} annotation files\n`,
);
