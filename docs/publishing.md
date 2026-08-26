# Publishing to npm

Publishing uses two workflows. A push to `main` runs `.github/workflows/release-tag.yml`. This
workflow runs semantic-release over the Conventional Commit history. The workflow updates
`package.json` and `package-lock.json`, then commits those version changes. The workflow then
creates the next `v`-prefixed tag on that release commit.

That tag starts `.github/workflows/publish.yml`. This second workflow verifies that the checked-out
package version matches the tag. The workflow creates a GitHub release with generated notes and
builds the package with Vite+ Pack. The workflow then publishes the contents selected by
`package.json`.

The npm publish uses trusted publishing (OIDC). Trusted publishing does not need a long-lived
`NPM_TOKEN` secret.

## One-time npm setup

Check `npm view textlint-rule-preset-ste-ai` first. An existing package means this section is
already done.

If the package has not been published to npm yet, a maintainer must bootstrap it once. This lets
npm attach a trusted publisher:

1. Sign in to npm with an account that owns the package name and has two-factor authentication
   enabled.
2. Start from a clean checkout of the commit to release.
3. Run `vp install --frozen-lockfile`, then `vp check`, then `vp test`, then `vp pack`.
4. Confirm the tarball with `npm pack --dry-run`.
5. Run `npm publish --access public`.
6. This manual step is the only publish that requires you to log in to npm interactively.
7. The local bootstrap does not have GitHub's OIDC identity.
8. Provenance therefore starts with the subsequent Continuous Integration (CI) publishes.
9. On npmjs.com, open **Packages → textlint-rule-preset-ste-ai → Settings → Trusted Publisher** and
   select **GitHub Actions**.
10. Enter organization or user `Jamie-BitFlight`, repository `textlint-rule-preset-ste-ai`, workflow
    filename `publish.yml`, and environment `npm`.
11. Allow the **npm publish** action.
12. After verifying trusted publishing, set publishing access to **Require two-factor authentication
    and disallow tokens**.
13. The workflow uses short-lived OIDC credentials and does not need a token.

## One-time GitHub setup

Create a GitHub environment named `npm` under **Settings → Environments**. Add required reviewers or
other deployment protection rules if releases should require explicit approval. Do not add an npm
token secret.

Create a GitHub App that can write repository contents. Install the App on this repository. Allow
the App to bypass the `main` branch rule for semantic-release's version commit. Configure these
Actions values:

- Repository variable `RELEASE_APP_ID`: the App ID.
- Repository secret `RELEASE_APP_PRIVATE_KEY`: a private key generated for the App.

The App token is necessary because GitHub suppresses new workflow runs for tags created with a
workflow's built-in `GITHUB_TOKEN`. The App-created semantic-release tag can trigger the separate
publish workflow. The tag workflow ignores semantic-release's own `chore(release)` commit. This
exclusion stops the version commit from starting another release calculation. The tag-triggered
publish workflow still runs. That workflow triggers off the tag, not off the commit.

## Publishing a version

1. Merge Conventional Commits to `main`.
2. A `fix:` commit creates a patch release.
3. A `feat:` commit creates a minor release.
4. A breaking change creates a major release.
5. Commits without a release-bearing type do not create a tag.
6. Confirm **Create semantic release tag** created a `chore(release)` commit with the updated
   versions.
7. Confirm **Create semantic release tag** tagged that exact commit.
8. The tag automatically starts **Publish package**.
9. **Publish package** confirms that `package.json` already matches the tag.
10. **Publish package** runs the checks and tests.
11. **Publish package** creates the GitHub release notes.
12. **Publish package** publishes the package to npm.
13. Approve the `npm` environment deployment if GitHub requests approval.
14. Confirm the workflow completed.
15. Verify the version and provenance badge on npmjs.com.

npm rejects publishing a version that already exists. If npm already accepted the package, retry
with a new version. Do not rerun the same release.
