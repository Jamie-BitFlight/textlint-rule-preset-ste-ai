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
# So each fixture declares a digest of its annotation — object keys sorted so reformatting is not a
# change, array order preserved so reordering is. Any edit to any record now has to be accompanied
# by a new digest here, in the same commit as the edit.
#
# An earlier revision digested only `changes`, on the reasoning that an adjudication is anchored by
# binding to a live candidate passage and so needs no digest. That inference is wrong, and a review
# demonstrated it: the binding constrains *where a record sits*, not *what it says*. `verdict`,
# `reason` and `reviewerConfidence` are copied from the reviewer row verbatim and checked against
# nothing. What constrained them was two aggregates in `test/fixtures/corpus.test.ts` — the global
# class balance, and one per-rule tally — and a balanced promote/demote preserves both. Those two
# aggregates have since been replaced by a record-by-record comparison against `fixtures/verdicts/`,
# which the swap below does not survive; the digest here is still what pins the keys no other check
# reads. Measured:
# demoting the corpus's two confirmed `passive-voice-candidate` defects and promoting two other
# passages of the same rule passed every gate and all 576 tests, silently moving which passages the
# semantic evaluators are scored against. Digesting the whole annotation closes that, and covers the
# keys no check reads at all (`notes`, `original`, `compliant`) rather than leaving them to be
# noticed one at a time.
#
# Every declaration below is overridable from the environment, and `ANNOTATIONS_DIR` / `FIXTURES_DIR`
# redirect the corpus, so `test/e2e/check-annotation-provenance.test.ts` can point the script at a
# synthetic corpus and assert what it refuses. CI invokes it with none of those set and gets the
# values here — checked: no workflow `env:`, no `.env`, and no other script exports these names.
# That indirection exists because a review deleted every check in this file one at a time and the
# project stayed green each time: nothing tested the gate that tests the corpus.
#
# Usage: scripts/ci/check-annotation-provenance.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

# Adjudication records, and the four reviewer runs that produced them, per fixtures/verdicts/.
export EXPECTED_ADJUDICATIONS="${EXPECTED_ADJUDICATIONS:-105}"
export EXPECTED_ADJUDICATION_REVIEWERS="${EXPECTED_ADJUDICATION_REVIEWERS:-reviewer-a=25,reviewer-b=25,reviewer-c=23,reviewer-d=32}"
# Rewrite records, and the two rewriter runs, split nine fixtures each.
export EXPECTED_CHANGES="${EXPECTED_CHANGES:-70}"
export EXPECTED_CHANGE_REVIEWERS="${EXPECTED_CHANGE_REVIEWERS:-rewriter-a=36,rewriter-b=34}"
# Every record in the corpus was produced by an agent run. A human-authored record is a real
# possibility and the schema allows it; it is not something that should arrive unnoticed.
export EXPECTED_KINDS="${EXPECTED_KINDS:-agent=175}"
# The evaluation partition is a corpus decision, not a mutable label. Pin each assignment so a
# balanced dev/heldout rearrangement cannot preserve the aggregate split checks and pass.
export EXPECTED_SPLITS="${EXPECTED_SPLITS:-curl-url-option-reference=heldout
django-settings-configuration=dev
httpd-mod-ssl-directive-config=heldout
httpd-mod-ssl-overview=heldout
k8s-audit-log-troubleshooting=dev
k8s-debug-pod-troubleshooting=dev
llvm-getting-started-build=dev
llvm-standalone-build-table=dev
node-cli-hard-negative=heldout
osha-lockout-tagout-warning=dev
osha-ppe-requirements=heldout
postgres-vacuum-overview=heldout
sqlite-cli-description=dev
sqlite-cli-dot-commands=dev
sqlite-pragma-hard-negative=dev
sqlite-vacuum-space-reclaim=dev
zephyr-dependency-setup=dev
zephyr-dependency-table=dev}"
# Which runs worked on which fixture, and a digest of that fixture's annotation:
# `<fixture>=<reviewers joined by +>|<sha256 of the canonical annotation>`.
# `sqlite-pragma-hard-negative` names one run because it emits no candidates, so no adjudication
# reviewer ever touched it. To refresh a digest after an intended edit, run the script — the failure
# names the fixture and prints the digest its records now have.
export EXPECTED_PER_FIXTURE="${EXPECTED_PER_FIXTURE:-curl-url-option-reference=reviewer-b+rewriter-a|82df9668fd4f301cffbd35555d5352ca6b9bc28ff470c8cdc30604e3907ac8ec
django-settings-configuration=reviewer-d+rewriter-a|49861fb07a211131c5bd4a0c0639c620251014322c4bfd64f3dd9d65a289d342
httpd-mod-ssl-directive-config=reviewer-a+rewriter-b|74b196d5ed6f41bc87666b50429cc1f9f0e24544cf0f888b59c9040f360f72ab
httpd-mod-ssl-overview=reviewer-b+rewriter-a|923b306b1b73f46bb4bed005d02addcfb8e77cc85b92ad5bbb3038f44e123d22
k8s-audit-log-troubleshooting=reviewer-c+rewriter-b|1aca2ad77aae62af0622137e3fb93f909508c34b353f2a1b2cedd3fda9840482
k8s-debug-pod-troubleshooting=reviewer-c+rewriter-a|96614cfe3a49af8cde244adf417d86b0b6b32ca90a5bf13f16019617e3dc9b40
llvm-getting-started-build=reviewer-a+rewriter-a|f4cec98fb7a2d3d65cb3bf760078b6143ae207078945ab6094075d8865057569
llvm-standalone-build-table=reviewer-a+rewriter-b|1f2ebb69ec74843d2a56e08d4d7d39dfd6ec5a00cb52c22b851a7d481f6a47c2
node-cli-hard-negative=reviewer-d+rewriter-b|e95141872f6dd00569b4adb7a575ecf5bb3b4ae0645febf4bf3d2299780e96d6
osha-lockout-tagout-warning=reviewer-c+rewriter-a|520b13f234af1f67160234cbb6de7c55348c95bf57aacbd0488a8b1f55d22991
osha-ppe-requirements=reviewer-d+rewriter-b|c17af3c3ef8581e1498601236bdb8be5ee14bf370f48a6d44ceb17378bbdb7a0
postgres-vacuum-overview=reviewer-b+rewriter-b|8a5a59fe3d8065559475ee4bae5393b847c0ca6d0979ae12d219476802b5c80a
sqlite-cli-description=reviewer-a+rewriter-b|3bd454e25554da7b4bf4d039088d732603677e702fad805940ab659835d3d01e
sqlite-cli-dot-commands=reviewer-c+rewriter-a|ecbc21ba560df1dc433352ef6bbe77f0b6bb6d655e58aceebdf927cdec67f44a
sqlite-pragma-hard-negative=rewriter-b|d82255533037474391d7aef55f5cf4939d917a0a8f97c839a0ee62cd34b47418
sqlite-vacuum-space-reclaim=reviewer-d+rewriter-a|e55a769b2e5a25162da273e45d1b42700234718646a8f0261b0ebf724f8f28f4
zephyr-dependency-setup=reviewer-a+rewriter-a|cb9b09a412e8a7115d6b1b458fc6ae995bb944fe3f44bfb38b41618f443d988a
zephyr-dependency-table=reviewer-b+rewriter-b|fb1f6d85d91b22f46089aaedf4218580e99619d3fa0e9b566815b74351c96c81}"

node --input-type=module -e '
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseJsonStrict } from "./scripts/lib/parse-json-strict.mjs";

// Keys sorted so a reformat is not a change; array order preserved so a reorder is one.
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).toSorted().map((k) => [k, canonical(value[k])]))
      : value;
const digestOf = (annotation) =>
  createHash("sha256").update(JSON.stringify(canonical(annotation))).digest("hex");

const dir = process.env.ANNOTATIONS_DIR ?? "fixtures/annotations";
const tally = (pairs) => [...pairs.entries()].toSorted(([a], [b]) => a.localeCompare(b))
  .map(([k, v]) => `${k}=${v}`).join(",");

let adjudications = 0;
let changes = 0;
const byAdjudicationReviewer = new Map();
const byChangeReviewer = new Map();
const byKind = new Map();
const perFixture = new Map();
const bump = (map, k) => map.set(k, (map.get(k) ?? 0) + 1);

// Every committed fixture JSON, not just the annotations. A previous revision guarded the
// annotations alone and argued the rest was defence in depth; a review disproved that by moving the
// identical forgery one directory over. `fixtures/verdicts/` is where the adjudications are
// *derived from*, so a duplicated `reviewer`/`reviewerKind` there flows the last value into every
// record while the committed annotation and its digest stay byte-identical — the file reads as
// human-audited and `agent=175` still matches. The same trick on `fixtures/manifest.json` makes the
// manifest document a share-alike licence while `validate.ts` reads the permissive duplicate,
// walking straight through the gate that exists to refuse copyleft. Scanning the whole tree also
// covers files added later without anyone remembering this.
const fixturesDir = process.env.FIXTURES_DIR ?? "fixtures";
if (existsSync(fixturesDir)) {
  for (const entry of readdirSync(fixturesDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(entry.parentPath ?? fixturesDir, entry.name);
    try {
      parseJsonStrict(readFileSync(path, "utf8"), path);
    } catch (error) {
      // Reported the way every other failure here is, rather than as a stack trace.
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}


const manifestPath = join(fixturesDir, "manifest.json");
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const actualSplits = manifest.fixtures.map((fixture) => `${fixture.id}=${fixture.split}`).toSorted().join("\n");
  if (actualSplits !== process.env.EXPECTED_SPLITS) {
    console.error(`fixture splits changed. Declared:\n${process.env.EXPECTED_SPLITS}\nFound:\n${actualSplits}`);
    process.exitCode = 1;
  }
}

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
    `${[...named].toSorted((a, b) => a.localeCompare(b)).join("+")}|${digestOf(annotation)}`,
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
      `${fixture}: annotation content changed. Declared ${expectedDigest}, found ${actualDigest}.`,
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
