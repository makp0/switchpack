# Releasing switchpack

[Google's Release Please](https://github.com/googleapis/release-please) generates
`CHANGELOG.md`, version bumps, and GitHub release notes from Conventional Commits.
Do not hand-edit the changelog, bump `package.json` manually, or create release
tags for the normal release flow.

## Normal workflow

1. Use Conventional Commits for changes merged into `main`:
   - `fix: repair MTP reconnects` produces a patch release.
   - `feat: add package sources` produces a minor release.
   - `feat!: change manifest format` declares a breaking change. Before 1.0,
     breaking changes bump the minor version.
   - `docs:`, `ci:`, and `chore:` changes alone do not normally trigger a release.
2. Release Please opens or updates a release PR with the proposed version and
   generated changelog. Review that PR and merge when ready.
3. The merge makes Release Please create a tag and a **draft** GitHub release
   with generated notes. The same workflow calls the release build directly.
4. CI tests and builds macOS/Linux ARM64/x64 archives at that exact tag. The
   release job uploads the archives and `SHA256SUMS`, then publishes the draft
   without replacing its generated notes. A failed build leaves the draft
   unpublished, so Homebrew continues using the last complete release.

`release-please-config.json` sets the strategy. `.release-please-manifest.json`
records the released version; Release Please maintains it after bootstrap.
The bootstrap commit is the existing v0.2.0 release, so its already released
changes will not appear again in the first generated changelog.

## Permissions and GitHub events

The workflow uses the repository's built-in `GITHUB_TOKEN`; no personal token
or cross-repository secret is required. Repository settings must allow GitHub
Actions to create PRs (Settings → Actions → General → Workflow permissions →
**Allow GitHub Actions to create and approve pull requests**). This repository
has that setting enabled. Release PRs still need human review and merge.

Events created by `GITHUB_TOKEN` do not trigger other workflows. That is why
Release Please calls the reusable release workflow directly instead of relying
on a tag-push or release event. For the same reason, its bot-created release PRs
do not automatically trigger pull-request CI. CI runs on the merge to `main`,
and all four build jobs must pass before the draft can be published. If required
PR checks are added later, use a GitHub App token to trigger those PR events.

## Retry a failed release

Use GitHub's Re-run failed jobs action. If the release-creation job already
completed, rebuild and publish its existing draft directly:

```sh
gh workflow run release.yml --repo makp0/switchpack -f tag=v0.2.1
```

Use the failed draft's actual tag. The workflow verifies its package version,
only replaces assets on a draft, and refuses to overwrite a published release.
The CLI reads its version from `package.json`; there is no separate version to
maintain. Existing v0.1.0 and v0.2.0 releases remain as published.

## Homebrew updates

The formula lives in [makp0/homebrew-tap](https://github.com/makp0/homebrew-tap).
Its workflow checks the latest published release hourly, validates checksums,
tests installation on macOS, then commits the generated formula. Drafts remain
invisible to this process. To refresh it immediately after publication:

```sh
gh workflow run update.yml --repo makp0/homebrew-tap
```

After the tap workflow succeeds, users can run `brew update` and
`brew upgrade switchpack`. A new patch release is the way to correct a published
release; never move its tag or replace its archives.
