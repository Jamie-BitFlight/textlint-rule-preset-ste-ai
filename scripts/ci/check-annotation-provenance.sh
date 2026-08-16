#!/usr/bin/env bash
#
# Pin the corpus's provenance totals, so a record cannot be re-credited, invented or deleted quietly.
#
# `merge-candidate-verdicts.mjs --check` proves the annotation's `reviewers` array is exactly the set
# of names its records carry. That is a consistency check, not a provenance one: the `changes`
# records are compared against nothing outside the file they live in, so editing every
# `changes[].reviewer` in an annotation *and* its `reviewers` array to a fabricated name leaves both
# gates green — measured, not supposed. The same holds for adding a rewrite record that never
# happened, deleting several, or flipping `reviewerKind` on the ones that remain.
#
# So the totals are asserted here instead, the way `check-rules-provisional.sh` asserts the rule
# count. These numbers are expected to change — a new fixture changes them — and that is the point:
# the change becomes a deliberate edit to this file, next to the diff that caused it, rather than
# something a corpus can drift through unremarked.
#
# Usage: scripts/ci/check-annotation-provenance.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

# Adjudication records, and the four reviewer runs that produced them, per fixtures/verdicts/.
export EXPECTED_ADJUDICATIONS=105
export EXPECTED_ADJUDICATION_REVIEWERS='reviewer-a=25,reviewer-b=25,reviewer-c=23,reviewer-d=32'
# Rewrite records, and the two rewriter runs, split nine fixtures each.
export EXPECTED_CHANGES=70
export EXPECTED_CHANGE_REVIEWERS='rewriter-a=36,rewriter-b=34'
# Every record in the corpus was produced by an agent run. A human-authored record is a real
# possibility and the schema allows it; it is not something that should arrive unnoticed.
export EXPECTED_KINDS='agent=175'

node --input-type=module -e '
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = "fixtures/annotations";
const tally = (pairs) => [...pairs.entries()].toSorted(([a], [b]) => a.localeCompare(b))
  .map(([k, v]) => `${k}=${v}`).join(",");

let adjudications = 0;
let changes = 0;
const byAdjudicationReviewer = new Map();
const byChangeReviewer = new Map();
const byKind = new Map();
const bump = (map, k) => map.set(k, (map.get(k) ?? 0) + 1);

for (const file of readdirSync(dir).toSorted()) {
  const annotation = JSON.parse(readFileSync(join(dir, file), "utf8"));
  for (const change of annotation.changes) {
    changes += 1;
    bump(byChangeReviewer, change.reviewer);
    bump(byKind, change.reviewerKind);
  }
  for (const record of annotation.candidateAdjudications ?? []) {
    adjudications += 1;
    bump(byAdjudicationReviewer, record.reviewer);
    bump(byKind, record.reviewerKind);
  }
  // The array is derived by the merge tool, but only that tool checks it; assert it here too so a
  // corpus edited without re-running the tool cannot reach CI looking consistent.
  const named = new Set([
    ...annotation.changes.map((c) => c.reviewer),
    ...(annotation.candidateAdjudications ?? []).map((r) => r.reviewer),
  ]);
  const declared = JSON.stringify(annotation.reviewers);
  const derived = JSON.stringify([...named].toSorted((a, b) => a.localeCompare(b)));
  if (declared !== derived) {
    console.error(`${file}: reviewers ${declared} is not the set its records carry, ${derived}`);
    process.exitCode = 1;
  }
}

const checks = [
  ["adjudication records", String(adjudications), process.env.EXPECTED_ADJUDICATIONS],
  ["adjudication reviewers", tally(byAdjudicationReviewer), process.env.EXPECTED_ADJUDICATION_REVIEWERS],
  ["rewrite records", String(changes), process.env.EXPECTED_CHANGES],
  ["rewrite reviewers", tally(byChangeReviewer), process.env.EXPECTED_CHANGE_REVIEWERS],
  ["reviewer kinds", tally(byKind), process.env.EXPECTED_KINDS],
];

for (const [label, actual, expected] of checks) {
  if (actual !== expected) {
    console.error(`${label}: expected ${expected}, found ${actual}`);
    process.exitCode = 1;
  }
}

if (process.exitCode === undefined || process.exitCode === 0) {
  console.log(
    `${adjudications} adjudications and ${changes} rewrites, all provenance totals as declared`,
  );
}
' </dev/null && exit_code=0 || exit_code=$?

if [ "$exit_code" -ne 0 ]; then
  echo "" >&2
  echo "The corpus provenance totals no longer match the ones declared in $0." >&2
  echo "If the change was intended, update the expected values there in the same commit." >&2
fi
exit "$exit_code"
