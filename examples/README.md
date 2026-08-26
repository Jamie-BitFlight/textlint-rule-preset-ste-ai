# Examples

Config files and a document to run them against. Run them together. You see real findings before
you wire this preset into your own project.

| File               | Purpose                                                                        |
| ------------------ | ------------------------------------------------------------------------------ |
| `.textlintrc.json` | A complete `textlint` config: every rule enabled, with representative options. |
| `.ste-ai.json`     | A complete shared-configuration file: approved terms, autofix, diagnostics.    |
| `sample.md`        | A short document with deliberate violations, for the commands below.           |

Do you want the minimal config for a real project instead? See the root
[`README.md`](../README.md#install) `Install` section. The files here are the full reference, not
the quickest path.

Do you want to replace the bundled vocabulary with your own? That is a rule pack, and
[`rule-pack/`](./rule-pack/) is a complete worked one. It lints one document under the bundled
pack, then under a custom pack. You see exactly what changes.

## Try it

Run these commands from the repository root.

```bash
vp install
vp pack
node_modules/.bin/textlint --config examples/.textlintrc.json examples/sample.md
```

This resolves `preset-ste-ai` the same way it resolves for a real consumer. `textlint` uses its own
module resolution here, not a shortcut. `package.json` links this package into its own
`node_modules`. See the root README's `Development` section for that mechanism.

`vp pack` has to run first. That resolution needs a built `dist/` directory.
`scripts/ci/check-textlint-configs-resolve.sh` runs this same check automatically, so the shipped
config files stay provably resolvable.

The command above prints the current findings. Expect two categories. A few are deterministic
errors: unapproved vocabulary, a repeated word, a contraction, an overlong sentence. The rest are
`info`-level candidates. Those need semantic adjudication to decide, and that step is off here,
since no model service is configured. See [`docs/llama-cpp-setup.md`](../docs/llama-cpp-setup.md) to
turn it on.

Apply the fixable findings:

```bash
node_modules/.bin/textlint --config examples/.textlintrc.json --fix examples/sample.md
```
