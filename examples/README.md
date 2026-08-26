# Examples

Two config files and a document to run them against, so you can see real findings before wiring
this preset into your own project.

| File               | Purpose                                                                        |
| ------------------ | ------------------------------------------------------------------------------ |
| `.textlintrc.json` | A complete `textlint` config: every rule enabled, with representative options. |
| `.ste-ai.json`     | A complete shared-configuration file: approved terms, autofix, diagnostics.    |
| `sample.md`        | A short document with deliberate violations, for the commands below.           |

For the minimal config to copy into a real project, see the root [`README.md`](../README.md#install)
`Install` section instead — these two files are the full reference, not the quickest path.

## Try it

From the repository root:

```bash
vp install
vp pack
node_modules/.bin/textlint --config examples/.textlintrc.json examples/sample.md
```

That resolves `preset-ste-ai` the same way it resolves for a real consumer — through `textlint`'s
own module resolution, not a shortcut — because `package.json` links this package into its own
`node_modules` (see the root README's `Development` section). `vp pack` has to run first because
that resolution needs a built `dist/`; `scripts/ci/check-textlint-configs-resolve.sh` runs this same
check in CI so both config files stay provably resolvable.

Expect around a dozen findings: a few deterministic errors (unapproved vocabulary, a repeated word,
a contraction, an overlong sentence) and several `info`-level candidates that need semantic
adjudication to decide (disabled here, since no model service is configured — see
[`docs/llama-cpp-setup.md`](../docs/llama-cpp-setup.md)).

Apply the fixable ones:

```bash
node_modules/.bin/textlint --config examples/.textlintrc.json --fix examples/sample.md
```
