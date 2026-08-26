#!/usr/bin/env bash
#
# Run the commands `examples/rule-pack/README.md` documents, and assert the results that page
# quotes.
#
# This exists because external review on PR #105 pointed out a real gap: the integration tests read
# `acme-pack.json` themselves and hand an inline object to `analyseTextDeterministic()`. They never
# load `untrusted.json` or `trusted.json` through `--config`, and never invoke the CLI. So CLI
# argument handling, shared-config loading, relative `rulePack` path resolution and output rendering
# could all break while those tests stayed green -- and the page claims its commands are pinned.
#
# What is checked here is therefore the documented entry point, end to end, with the shipped files:
# the finding counts the page quotes, the fact that a custom pack *replaces* the bundled dictionary
# rather than adding to it, and the trust gate's effect on the JSON `conformance` block.
#
# Usage: scripts/ci/check-rule-pack-example.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

cli="dist/cli/main.js"
sample="examples/rule-pack/sample.md"

if [ ! -f "$cli" ]; then
  echo "$cli is missing. Run 'vp pack' first." >&2
  exit 2
fi

for file in "$sample" examples/rule-pack/acme-pack.json examples/rule-pack/untrusted.json \
  examples/rule-pack/trusted.json; do
  if [ ! -f "$file" ]; then
    echo "$file is missing; examples/rule-pack/README.md documents it." >&2
    exit 2
  fi
done

fail() {
  echo "examples/rule-pack/README.md is stale: $1" >&2
  exit 1
}

# `lint` exits 1 whenever errors are present, which is the documented behaviour, so the exit status
# is captured rather than allowed to kill the script under `set -e`.
run_lint() {
  local output
  set +e
  output="$(node "$cli" lint "$sample" "$@" 2>&1)"
  set -e
  printf '%s' "$output"
}

error_count() {
  printf '%s' "$1" | grep -oE '^[0-9]+ error' | grep -oE '[0-9]+' || echo "unknown"
}

# 1. The bundled pack. The page says one error, on "Utilise".
bundled="$(run_lint --deterministic-only)"
[ "$(error_count "$bundled")" = "1" ] ||
  fail "the bundled pack reported $(error_count "$bundled") error(s), not the documented 1"
printf '%s' "$bundled" | grep -q 'Utilise' ||
  fail 'the bundled pack no longer reports "Utilise"'

# 2. The custom pack, untrusted. The page says three errors, and that "Utilise" is gone because a
#    pack replaces the dictionary rather than adding to it. That claim is the point of the example.
untrusted="$(run_lint --config examples/rule-pack/untrusted.json --deterministic-only)"
[ "$(error_count "$untrusted")" = "3" ] ||
  fail "the custom pack reported $(error_count "$untrusted") error(s), not the documented 3"

for term in 'De-energise' 'Actuate' 'torque tool'; do
  printf '%s' "$untrusted" | grep -q "$term" ||
    fail "the custom pack no longer reports \"$term\""
done

printf '%s' "$untrusted" | grep -q 'Utilise' &&
  fail 'the custom pack now reports "Utilise"; the page says a pack replaces the dictionary'

printf '%s' "$untrusted" | grep -q 'WidgetPro' &&
  fail 'approvedTechnicalTerms no longer protects "Acme WidgetPro"'

# 3. The trust gate, read from the JSON output the page quotes. The findings are identical either
#    way; what changes is the authority the linter acted on.
conformance() {
  set +e
  node "$cli" lint "$sample" --config "$1" --deterministic-only --json 2>/dev/null |
    node -e "let s='';process.stdin.on('data',(d)=>{s+=d}).on('end',()=>{const c=JSON.parse(s).conformance;console.log(c.claim+' '+c.packAuthority)})"
  set -e
}

untrusted_claim="$(conformance examples/rule-pack/untrusted.json)"
[ "$untrusted_claim" = "none supplementary" ] ||
  fail "untrusted conformance was \"$untrusted_claim\", not the documented \"none supplementary\""

trusted_claim="$(conformance examples/rule-pack/trusted.json)"
[ "$trusted_claim" = "declared-by-supplier normative" ] ||
  fail "trusted conformance was \"$trusted_claim\", not the documented \"declared-by-supplier normative\""

echo "examples/rule-pack/README.md: all documented commands produce the results the page quotes."
