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
# Totals alone are not enough, because they are an aggregate and aggregates are preserved by
# rearrangement. Measured: moving one record's credit from `rewriter-a` to `rewriter-b` in one
# annotation while moving one the other way in another leaves 36/34 exactly as declared, and passed.
# So the per-fixture reviewer sets are declared too — each fixture names the runs that worked on it,
# which the balanced swap changes even though the totals do not.
#
# A reviewer *set* is an aggregate as well, and the same argument applies one level up. Measured:
# splicing a real `disputed` record out of `curl-url-option-reference` and putting a second copy of
# that file's own `accepted` record in its place changes no total, no per-run count and no name set,
# and passed every gate in the project — provenance, `check-candidate-ground-truth.sh`,
# `validate-fixtures.mjs` and all 565 tests. It moved the corpus's headline split from 32 accepted /
# 36 disputed to 33 / 35. Scaled up, the same shuffle reaches 45 / 23 while every declared value
# here still matches.
#
# Nothing outside the annotation constrains a `changes` record: unlike an adjudication, it binds to
# no live candidate passage, so there is no anchor to check it against. The only thing left to pin
# is the content itself, so each fixture declares a digest of its `changes` array — object keys
# sorted so reformatting is not a change, array order preserved so reordering is. Any edit to any
# rewrite record now has to be accompanied by a new digest here, in the same commit as the edit.
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
# Which runs worked on which fixture, and a digest of that fixture's rewrite records:
# `<fixture>=<reviewers joined by +>|<sha256 of the canonical changes array>`.
# `sqlite-pragma-hard-negative` names one run because it emits no candidates, so no adjudication
# reviewer ever touched it. To refresh a digest after an intended edit, run the script — the failure
# names the fixture and prints the digest its records now have.
export EXPECTED_PER_FIXTURE='curl-url-option-reference=reviewer-b+rewriter-a|d85c4e0dcd31646869c064eb5469615b2131e57f18e3c2879f8e27361f998206
django-settings-configuration=reviewer-d+rewriter-a|68f2fe76e0ff452b33065cff4d7b31be767b25774d143c3e92e4f25371102460
httpd-mod-ssl-directive-config=reviewer-a+rewriter-b|f179502f5ac3c56cca62e3afe709a2de2d5046ce9e57d5eb622b4f9522a2b27c
httpd-mod-ssl-overview=reviewer-b+rewriter-a|fe043330842f65593ef1e21fc94873489da3d4775e44fadb232d23e7dfb21a51
k8s-audit-log-troubleshooting=reviewer-c+rewriter-b|27483df00fe470095ed9711f221bd70f0ac94d11ff36948ddae5810408f51e64
k8s-debug-pod-troubleshooting=reviewer-c+rewriter-a|391ecf2626d188f202d1fe410383eaf67b9e0c2b6b129e45380f8079a28976f9
llvm-getting-started-build=reviewer-a+rewriter-a|06095bead4ecd9c6b72c6ddfbc1907971614e4748edcd68bc43b4b1cd57e685d
llvm-standalone-build-table=reviewer-a+rewriter-b|918ec99375671ae7e1a8a76659838feebb256ababbd7629b00b443369f414989
node-cli-hard-negative=reviewer-d+rewriter-b|a5e50cab3f418340ab6ad2f87e9c1dd430ca763ce4443f231fa641057d5b7b49
osha-lockout-tagout-warning=reviewer-c+rewriter-a|27be2f90e6b99db710bd565dc68aa3279fe3f43b70882f5b781591c755190830
osha-ppe-requirements=reviewer-d+rewriter-b|75d27c85c40e016b31d035f0b1ab12f431c7453b11fe27a2b0cb824fa2ec9362
postgres-vacuum-overview=reviewer-b+rewriter-b|59c6a68026b1c40d2c030e7c6c7659b3d254c7abb4c4822703f1ad22214de2a1
sqlite-cli-description=reviewer-a+rewriter-b|43169f9678d4a2d1a0944a80ba678fc1394ffe6edb08671a13ade0e1508add36
sqlite-cli-dot-commands=reviewer-c+rewriter-a|574b7d220509f69198e90d55cc839f2ca62f51966149fecd57f33e4148ffbd2e
sqlite-pragma-hard-negative=rewriter-b|0976f6f52b9651266796748ca3d77472fe076c0e5ad14518002d9fadf407fea5
sqlite-vacuum-space-reclaim=reviewer-d+rewriter-a|c8426005605e803f6be4c523f72d1b58282b94d421939bb4015ad1af9ef1d18b
zephyr-dependency-setup=reviewer-a+rewriter-a|19b2fd4fd268b423bb06a543893f3b713f33b519828be04bbe22992a60c486b1
zephyr-dependency-table=reviewer-b+rewriter-b|193a9ad48b4a6e758283f51de6edc1bdd344913058554b2786371679b9837dd3'

node --input-type=module -e '
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Keys sorted so a reformat is not a change; array order preserved so a reorder is one.
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).toSorted().map((k) => [k, canonical(value[k])]))
      : value;
const digestOf = (changes) =>
  createHash("sha256").update(JSON.stringify(canonical(changes))).digest("hex");

const dir = "fixtures/annotations";
const tally = (pairs) => [...pairs.entries()].toSorted(([a], [b]) => a.localeCompare(b))
  .map(([k, v]) => `${k}=${v}`).join(",");

let adjudications = 0;
let changes = 0;
const byAdjudicationReviewer = new Map();
const byChangeReviewer = new Map();
const byKind = new Map();
const perFixture = new Map();
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
  perFixture.set(
    file.replace(/\.json$/, ""),
    `${[...named].toSorted((a, b) => a.localeCompare(b)).join("+")}|${digestOf(annotation.changes)}`,
  );
}

// Per fixture, not just in total, and by content rather than only by name. A rearrangement that
// moves credit between fixtures in opposite directions leaves every aggregate above untouched, and
// a shuffle of records between fixtures crediting the same run leaves the name sets untouched too.
// The digest is what neither of them survives.
const expectedPerFixture = new Map(
  (process.env.EXPECTED_PER_FIXTURE ?? "").split("\n").filter(Boolean).map((line) => {
    const at = line.indexOf("=");
    return [line.slice(0, at), line.slice(at + 1)];
  }),
);
for (const [fixture, actual] of perFixture) {
  const expected = expectedPerFixture.get(fixture);
  if (expected === undefined) {
    console.error(`${fixture}: no expected reviewer set is declared for this fixture`);
    process.exitCode = 1;
    continue;
  }
  const [expectedNames, expectedDigest] = expected.split("|");
  const [actualNames, actualDigest] = actual.split("|");
  if (expectedNames !== actualNames) {
    console.error(`${fixture}: expected reviewers ${expectedNames}, found ${actualNames}`);
    process.exitCode = 1;
  }
  if (expectedDigest !== actualDigest) {
    console.error(
      `${fixture}: rewrite records changed. Declared ${expectedDigest}, found ${actualDigest}.`,
    );
    process.exitCode = 1;
  }
}
for (const fixture of expectedPerFixture.keys()) {
  if (!perFixture.has(fixture)) {
    console.error(`${fixture}: declared here, but no such annotation was read`);
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
