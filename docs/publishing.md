# Publishing to npm

Publishing uses two workflows. A push to `main` runs `.github/workflows/release-tag.yml`, where
semantic-release evaluates the Conventional Commit history, updates `package.json` and
`package-lock.json`, commits those versions, and creates the next `v`-prefixed tag on that release
commit. That tag starts `.github/workflows/publish.yml`, which verifies that the checked-out package
version matches the tag, creates a GitHub release with generated notes, builds the package with Vite+
Pack, and publishes the contents selected by `package.json`. The npm publish uses trusted publishing
(OIDC), so it does not need a long-lived `NPM_TOKEN` secret.

## One-time npm setup

The package does not exist on npm yet. A maintainer must bootstrap it once before npm can attach a
trusted publisher:

1. Sign in to npm with an account that owns the package name and has two-factor authentication
   enabled.
2. From a clean checkout of the commit to release, run `vp install --frozen-lockfile`, `vp check`,
   `vp test`, and `vp pack`.
3. Confirm the tarball with `npm pack --dry-run`, then run `npm publish --access public`. This is the
   only publish that needs interactive npm authentication. Provenance starts with the subsequent
   CI publishes because the local bootstrap does not have GitHub's OIDC identity.
4. On npmjs.com, open **Packages → textlint-rule-preset-ste-ai → Settings → Trusted Publisher** and
   select **GitHub Actions**.
5. Enter organization or user `Jamie-BitFlight`, repository `textlint-rule-preset-ste-ai`, workflow
   filename `publish.yml`, and environment `npm`. Allow the **npm publish** action.
6. After verifying trusted publishing, set publishing access to **Require two-factor authentication
   and disallow tokens**. The workflow uses short-lived OIDC credentials and does not need a token.

## One-time GitHub setup

Create a GitHub environment named `npm` under **Settings → Environments**. Add required reviewers or
other deployment protection rules if releases should require explicit approval. Do not add an npm
token secret.

Create a GitHub App that can write repository contents, install it on this repository, and allow the
App to bypass the `main` branch rule for semantic-release's version commit. Configure these Actions
values:

- Repository variable `RELEASE_APP_ID`: the App ID.
- Repository secret `RELEASE_APP_PRIVATE_KEY`: a private key generated for the App.

The App token is necessary because GitHub suppresses new workflow runs for tags created with a
workflow's built-in `GITHUB_TOKEN`. The App-created semantic-release tag is allowed to trigger the
separate publish workflow. The tag workflow ignores semantic-release's own `chore(release)` commit,
which prevents the version commit from starting another release calculation without suppressing the
tag-triggered publish workflow.

## Publishing a version

1. Merge Conventional Commits to `main`: `fix:` creates a patch, `feat:` creates a minor, and a
   breaking change creates a major release. Commits without a release-bearing type do not create a
   tag.
2. Confirm **Create semantic release tag** created a `chore(release)` commit with updated package and
   lockfile versions, then tagged that exact commit.
3. The tag automatically starts **Publish package**, which confirms `package.json` already matches
   the tag, runs the checks and tests, creates the GitHub release notes, and publishes to npm.
4. Approve the `npm` environment deployment if GitHub requests it.
5. Confirm the workflow completed and verify the version and provenance badge on npmjs.com.

npm rejects publishing a version that already exists. If a workflow must be retried after npm
accepted the package, publish a new version rather than rerunning the same release.
