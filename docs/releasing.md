# Releasing switchpack

1. Update `version` in `package.json`. The CLI reads its version from there.
2. Run `bun install --frozen-lockfile`, `bun test`, `bun run typecheck`,
   `bun run build`, and `bun run build:mtp`.
3. Commit and push. Wait for CI, then tag the matching version:

```sh
git tag -a v0.2.0 -m 'Release switchpack 0.2.0'
git push origin v0.2.0
```

Use the version being released. The Release workflow rejects tags that differ
from `package.json`. It runs CI on macOS ARM64/x64 and Linux ARM64/x64, then
publishes four `.tar.gz` archives and `SHA256SUMS`. A failed build prevents
publication. Archives include the CLI, helper source, starter manifest, example
lockfile, docs, and license notices. The helper is compiled during CI but its
binary is not bundled; Homebrew builds it against the user's libmtp.

## Homebrew updates

The formula lives in [makp0/homebrew-tap](https://github.com/makp0/homebrew-tap).
Its workflow checks the latest public release hourly, validates asset names and
checksums, regenerates the formula, tests installation on macOS, and commits the
update. No cross-repository token is needed. Refresh it immediately with:

```sh
gh workflow run update.yml --repo makp0/homebrew-tap
gh run list --repo makp0/homebrew-tap --workflow update.yml
```

After the workflow succeeds:

```sh
brew update
brew upgrade switchpack # or brew install makp0/tap/switchpack
brew test makp0/tap/switchpack
```

Do not move published tags or replace release archives. Users and Homebrew
depend on their checksums; publish a patch version for corrections. Before
publication, a failed workflow can be retried with GitHub's Re-run jobs action.
