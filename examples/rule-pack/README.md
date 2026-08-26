# A worked rule pack

A rule pack is how you replace the bundled vocabulary with your own. This directory holds a
complete one. The commands below lint the same document three times to show what changes.

| File             | Purpose                                                          |
| ---------------- | ---------------------------------------------------------------- |
| `acme-pack.json` | The pack. A small controlled vocabulary for a fictional company. |
| `sample.md`      | A document with deliberate violations of that vocabulary.        |
| `untrusted.json` | Configuration that loads the pack, and does not trust it.        |
| `trusted.json`   | The same, with the pack named in `trustedRulePackIds`.           |

Run every command from the repository root. Run `vp install` and `vp pack` first, because these
commands use the built CLI.

## 1. The bundled pack

```bash
node dist/cli/main.js lint examples/rule-pack/sample.md --deterministic-only
```

One error. The bundled dictionary flags `Utilise`, because that word is in its unapproved list. It
knows nothing about the Acme vocabulary, so `De-energise` and `Actuate` pass.

## 2. Your pack, loaded but untrusted

```bash
node dist/cli/main.js lint examples/rule-pack/sample.md \
  --config examples/rule-pack/untrusted.json --deterministic-only
```

Three errors, and they are different errors.

- `De-energise` and `Actuate` are now reported. Your pack lists them.
- `torque wrench` is now reported. Your pack prefers `torque tool`.
- `Utilise` is **no longer** reported.
- `Acme WidgetPro` is never reported. `approvedTechnicalTerms` protects it.

That third point is the one to remember. **A pack replaces the dictionary. It does not add to it.**
Anything the bundled pack used to catch is gone unless your pack lists it too. Do you want to keep
the general-English checks? Copy the entries you want out of `src/rule-pack/provisional-pack.ts`.

## 3. Your pack, trusted

```bash
node dist/cli/main.js lint examples/rule-pack/sample.md \
  --config examples/rule-pack/trusted.json --deterministic-only --json
```

The findings are identical. What changes is the authority reported for them. Compare the
`conformance` block against the untrusted run:

```jsonc
// untrusted.json
"conformance": {
  "claim": "none",
  "packAuthority": "supplementary",
  "disclaimer": "This tool does not certify conformance with any controlled-language standard."
}

// trusted.json
"conformance": {
  "claim": "declared-by-supplier",
  "packAuthority": "normative",
  "disclaimer": "This tool does not certify conformance with any controlled-language standard."
}
```

A pack cannot elevate itself. It declares `authority: "normative"` in both runs. Any JSON file can
declare that, so the declaration alone buys nothing. The operator must name the pack's
`metadata.id` in `trustedRulePackIds` before the linter acts on it. Until then the pack's data is
used and its authority is capped at `supplementary`.

The human-readable output still ends with `Provisional rules only; no conformance claim.` in every
run, including the trusted one. That line is unconditional today. See
[`docs/DISCLAIMER.md`](../../docs/DISCLAIMER.md) and
`docs/design/64-layered-rule-packs/02-authority-trust.md`, which record why it under-claims on
purpose. Read the `--json` output when you need the authority the linter actually acted on.

## What to copy

Copy `acme-pack.json`. Four fields then need your own values.

- `metadata.id` is the string `trustedRulePackIds` must match. The pack name and the file path do
  not count.
- `metadata.licence` and `metadata.source` record what you are entitled to supply.
- `dictionary` holds your terms.
- `rules[]` takes one entry per rule whose authority or defaults you want to set.

Leave `metadata.authority` as `provisional` until you are actually supplying licensed data.
[`docs/rule-pack-import.md`](../../docs/rule-pack-import.md) covers the full field list and the
licence obligations. Do not commit a proprietary pack to a public repository.

`scripts/ci/check-rule-pack-example.sh` runs each command above through the real command-line tool.
It uses these same files. It asserts the counts and the `conformance` values this page quotes. It
runs in continuous integration. The page therefore cannot drift from what the commands print.
`test/integration/rule-pack.test.ts` covers the same pack through the programmatic interface.
