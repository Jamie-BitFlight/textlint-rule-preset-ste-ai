/**
 * Merge reviewer verdicts on heuristic candidates into the fixture adjudication records.
 *
 * Input is a directory of reviewer files, each shaped:
 *
 *   { "reviewer": "<id>", "reviewerKind": "human" | "agent",
 *     "verdicts": { "<fixtureId>": [ { passageId, ruleId, evaluatorId,
 *       quote, span, verdict, reason, reviewerConfidence }, ... ] } }
 *
 * `reviewerKind` is declared once per file and stamped onto every record it produces. It is required
 * and undefaulted: `reviewer` is a free-form label, so without this a record cannot say what made it.
 *
 * Verdicts are joined to candidates on **(ruleId, span, quote)** — where the passage is and what it
 * says. `passageId` is deliberately not the join key. It embeds a sentence ordinal, and a sentence
 * ordinal moves whenever segmentation changes anywhere earlier in the document: fixing
 * reStructuredText admonition detection stopped `.. note::` lines from becoming blocks, which
 * renumbered every sentence after them and orphaned six verdicts whose spans and quotes had not
 * moved by a single byte. Those verdicts were still valid — a reviewer's judgement is about a
 * passage of text, not about a counter — so the join reflects that. `passageId` is carried through
 * as a label, taken from the current packet.
 *
 * A verdict that does not bind to a real passage is not ground truth, it is an assertion about
 * nothing, so the merge refuses rather than writing it.
 *
 * Usage:
 *   node scripts/merge-candidate-verdicts.mjs --verdicts DIR --packets DIR [--check]
 *
 * `--check` validates and reports without writing, which is what CI runs. It reads the annotation
 * files too, and reports any difference between what the verdicts imply and what is committed. The
 * annotation is the artefact; this script is only what produces it, so a check that stopped at "the
 * verdicts bind to live passages" would leave the artefact itself unchecked — a `reviewerKind`
 * flipped by hand in `fixtures/annotations/`, or a reason rewritten there, would survive CI intact.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

/** Stable identity of a candidate passage: which rule, and which characters. */
const key = (ruleId, span) => `${ruleId}@${span.start}-${span.end}`;

const jsonFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith('.json'));

/**
 * Every way a committed annotation can differ from what the verdicts produce, named field by field.
 *
 * "The file does not match" is true but useless in CI output: the interesting cases are a single
 * altered field on one record, and a record left behind after the candidate under it moved. Both
 * are reported as themselves, so the log says what to look at rather than which file to re-read.
 */
function describeDrift(fixtureId, committed, computed) {
  const out = [];
  const remaining = new Map(
    committed.map((record) => [key(record.ruleId, record.span ?? { start: -1, end: -1 }), record]),
  );
  for (const record of computed) {
    const id = key(record.ruleId, record.span);
    const found = remaining.get(id);
    if (found === undefined) {
      out.push(`${fixtureId}: annotation has no adjudication at ${id}`);
      continue;
    }
    remaining.delete(id);
    for (const [field, value] of Object.entries(record)) {
      if (JSON.stringify(found[field]) !== JSON.stringify(value)) {
        out.push(
          `${fixtureId}/${id}: annotation ${field} is ${JSON.stringify(found[field])}, the verdicts give ${JSON.stringify(value)}`,
        );
      }
    }
  }
  for (const id of remaining.keys()) {
    out.push(`${fixtureId}: annotation holds an adjudication at ${id} that no verdict produces`);
  }
  // Order is part of the artefact — the records are sorted by span so the file is stable — so a
  // reordered file is drift even when every record in it is right.
  if (out.length === 0) {
    const committedOrder = committed.map((record) => key(record.ruleId, record.span));
    const computedOrder = computed.map((record) => key(record.ruleId, record.span));
    if (JSON.stringify(committedOrder) !== JSON.stringify(computedOrder)) {
      out.push(`${fixtureId}: annotation holds the right adjudications in the wrong order`);
    }
  }
  return out;
}

// `process.exitCode` inside a wrapping function, not `process.exit()` mid-script, keeps the
// distinct "problems found" exit code without skipping the summary line every run (including a
// failing one) writes to stderr below.
function main() {
  let values;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        verdicts: { type: 'string', default: 'fixtures/verdicts' },
        packets: { type: 'string', default: 'fixtures/packets' },
        fixtures: { type: 'string', default: 'fixtures' },
        check: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  const verdictsDir = resolve(values.verdicts);
  const packetsDir = resolve(values.packets);
  const fixturesDir = resolve(values.fixtures);
  const checkOnly = values.check;

  const packets = new Map();
  for (const file of jsonFiles(packetsDir)) {
    const packet = JSON.parse(readFileSync(join(packetsDir, file), 'utf8'));
    packets.set(
      packet.fixtureId,
      new Map(packet.candidates.map((c) => [key(c.ruleId, c.span), c])),
    );
  }

  const problems = [];
  /** fixtureId -> passageId -> adjudication record */
  const merged = new Map();

  for (const file of jsonFiles(verdictsDir).toSorted()) {
    const doc = JSON.parse(readFileSync(join(verdictsDir, file), 'utf8'));
    const reviewer = doc.reviewer;
    if (typeof reviewer !== 'string' || reviewer.length === 0) {
      problems.push(`${file}: missing reviewer id`);
      continue;
    }
    // Declared once per reviewer file and stamped onto every record it produces. Required rather
    // than defaulted: `reviewer` is a label, so without this the records cannot say what made them,
    // and prose elsewhere has already drifted into implying they were written by people.
    const reviewerKind = doc.reviewerKind;
    if (reviewerKind !== 'human' && reviewerKind !== 'agent') {
      problems.push(`${file}: reviewerKind must be "human" or "agent"`);
      continue;
    }
    for (const [fixtureId, rows] of Object.entries(doc.verdicts ?? {})) {
      const candidates = packets.get(fixtureId);
      if (candidates === undefined) {
        problems.push(`${reviewer}: no candidate packet for fixture "${fixtureId}"`);
        continue;
      }
      for (const row of rows) {
        if (row.span === undefined || row.span === null) {
          problems.push(`${reviewer}/${fixtureId}: verdict for "${row.passageId}" has no span`);
          continue;
        }
        const id = key(row.ruleId, row.span);
        const candidate = candidates.get(id);
        if (candidate === undefined) {
          problems.push(`${reviewer}/${fixtureId}: no candidate at ${id}`);
          continue;
        }
        // The quote is the second half of the binding, and the half that catches a wrong span: a
        // verdict pointing at the right offsets in the wrong revision of a fixture would still fail.
        if (row.quote !== candidate.quote) {
          problems.push(
            `${reviewer}/${fixtureId}/${id}: quote does not match the text at that span`,
          );
        }
        if (row.evaluatorId !== candidate.evaluatorId) {
          problems.push(`${reviewer}/${fixtureId}/${id}: evaluatorId does not match packet`);
        }
        const byFixture = merged.get(fixtureId) ?? new Map();
        if (byFixture.has(id)) {
          problems.push(`${reviewer}/${fixtureId}: duplicate verdict for ${id}`);
          continue;
        }
        byFixture.set(id, {
          // Taken from the packet, not the verdict: this is a run-local label and the packet holds
          // the current one. The binding that matters is the span and the quote, both verified
          // above.
          passageId: candidate.passageId,
          ruleId: candidate.ruleId,
          evaluatorId: candidate.evaluatorId,
          quote: candidate.quote,
          span: { start: candidate.span.start, end: candidate.span.end },
          verdict: row.verdict,
          reason: row.reason,
          reviewer,
          reviewerKind,
          reviewerConfidence: row.reviewerConfidence,
        });
        merged.set(fixtureId, byFixture);
      }
    }
  }

  for (const [fixtureId, candidates] of packets) {
    const judged = merged.get(fixtureId) ?? new Map();
    for (const [id, candidate] of candidates) {
      if (!judged.has(id)) {
        problems.push(`${fixtureId}: candidate ${id} ("${candidate.passageId}") has no verdict`);
      }
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    process.stderr.write(`\n${problems.length} problem(s); nothing written.\n`);
    process.exitCode = 1;
    return;
  }

  const manifest = JSON.parse(readFileSync(join(fixturesDir, 'manifest.json'), 'utf8'));
  const drift = [];
  let written = 0;
  let total = 0;
  for (const fixture of manifest.fixtures) {
    // An empty record set is a real answer, not a reason to skip: a fixture whose candidates have
    // all disappeared still has an annotation holding the verdicts written about them, and
    // treating "no verdicts now" as "nothing to say" is exactly what leaves those records behind.
    const judged = merged.get(fixture.id) ?? new Map();
    // Sort by span so the file is stable regardless of which reviewer produced which row.
    const records = [...judged.values()].toSorted(
      (a, b) =>
        a.span.start - b.span.start || a.span.end - b.span.end || a.ruleId.localeCompare(b.ruleId),
    );
    total += records.length;
    const path = join(fixturesDir, fixture.annotationPath);
    const annotation = JSON.parse(readFileSync(path, 'utf8'));
    // `candidateAdjudications` carries `.default([])` in the schema, so an absent key and an empty
    // array are the same annotation. Read them as the same thing rather than reporting a
    // difference between two spellings of nothing.
    const committed = annotation.candidateAdjudications ?? [];
    // `annotation` comes from `JSON.parse`, so its element types are unresolved (`any`) to the
    // type checker even though every reviewer id is a string at runtime; give an explicit compare
    // instead of relying on the (unprovable-here) string-array default.
    const reviewers = [
      ...new Set([...(annotation.reviewers ?? []), ...records.map((r) => r.reviewer)]),
    ].toSorted((a, b) => String(a).localeCompare(String(b)));

    if (checkOnly) {
      drift.push(...describeDrift(fixture.id, committed, records));
      if (JSON.stringify(annotation.reviewers ?? []) !== JSON.stringify(reviewers)) {
        drift.push(
          `${fixture.id}: annotation reviewers are ${JSON.stringify(annotation.reviewers ?? [])}, the verdicts give ${JSON.stringify(reviewers)}`,
        );
      }
      continue;
    }

    // Writing `"candidateAdjudications": []` into an annotation that never carried the key adds a
    // diff that says nothing. Leave those alone; the two spellings already compare equal above.
    if (records.length === 0 && !Object.hasOwn(annotation, 'candidateAdjudications')) continue;
    annotation.candidateAdjudications = records;
    annotation.reviewers = reviewers;
    writeFileSync(path, `${JSON.stringify(annotation, null, 2)}\n`);
    written += 1;
  }

  if (drift.length > 0) {
    for (const problem of drift) process.stderr.write(`${problem}\n`);
    process.stderr.write(
      `\n${drift.length} difference(s) between the verdicts and the committed annotations.\n` +
        'Re-run without --check to rewrite them, then review the diff.\n',
    );
    process.exitCode = 1;
    return;
  }

  process.stderr.write(
    checkOnly
      ? `ok: ${total} verdicts bind to ${merged.size} fixtures and match the committed annotations\n`
      : `${total} verdicts written to ${written} annotation files\n`,
  );
}

main();
