# switchpack

A TypeScript + Bun CLI for managing Switch homebrew through a JSON manifest.
Commander.js handles commands and help; fflate reads ZIP release assets.

## Quick start

Requires Bun 1.3 or newer. From this directory:

```sh
bun install --frozen-lockfile
bun run cli --help

# Start in a staging folder to inspect the result.
mkdir -p ./sdroot
bun run cli install --target ./sdroot --dry-run
bun run cli install --target ./sdroot
bun run cli status --target ./sdroot

# Resolve newer releases, then install them.
bun run cli update --target ./sdroot --dry-run
bun run cli update --target ./sdroot
```

For your console, pass its mounted SD card root instead of `./sdroot`, e.g.
`--target /Volumes/SWITCH`. Hekate USB Mass Storage can expose the card without
removing it. The CLI also works with an ordinary staging directory whose files
you copy yourself. It does not connect over MTP or FTP.

The supplied `switchpack.json` installs Sphaira from `NaGaa95/sphaira`:

```json
{
  "schemaVersion": 1,
  "apps": {
    "sphaira": {
      "repo": "NaGaa95/sphaira",
      "version": "latest",
      "asset": "sphaira.zip",
      "files": {
        "switch/sphaira/sphaira.nro": "switch/sphaira/sphaira.nro"
      }
    }
  }
}
```

For ZIPs, `files` maps exact archive filenames to exact SD-relative filenames.
Only listed entries are extracted. For a direct release asset, replace `files`
with `"destination": "switch/example/example.nro"`. Asset names are exact,
with no wildcard matching. Destinations must be under `switch/`.

`version` accepts `latest` (GitHub's latest stable release) or an exact tag such as
`1.0.8`. Tags are literal: include a leading `v` only if the upstream tag has one.
Semver ranges are not supported.

## Commands and lockfile

| Command | Behavior |
| --- | --- |
| `install` | Reuse locked releases. Resolve new apps without lock entries. Reject changed app definitions until `update` is run. |
| `update` | Resolve each manifest entry again, download and verify it, and refresh the lockfile. Exact version pins remain pinned. |
| `status` | Compare local files with locked checksums, offline. Report unlocked, changed, missing, or modified apps. |

All commands require `--target`. Use `--manifest path/to/apps.json` to select a
different manifest. Its lockfile will be `path/to/apps.lock.json`.
Commit both manifest and lockfile for repeatable installs.

`install` and `update` support `--dry-run`: download and validate everything,
report planned writes, and leave both target and lockfile untouched. This still
uses the network. `status` does not check whether newer releases exist.

The lockfile records exact release tags, whole-asset SHA-256 checksums, file
checksums, and the app definition. A locked install verifies both asset and
extracted file checksums. Downloads use HTTPS, and GitHub-provided asset digests
are checked when available. Without an upstream digest, the first download's
checksum is recorded; a checksum alone does not authenticate its publisher.

Set `GITHUB_TOKEN` if GitHub API rate limits are a problem. The token is sent only
to the GitHub API, never in the manifest, lockfile, logs, or asset request.

## File handling

All apps are downloaded and checked before any app files are written. Files
already matching the expected checksum are skipped. Locally modified app files
are replaced on install/update, with their previous contents backed up under:

```text
<target>/switch/.switchpack/backups/<operation-id>/switch/...
```

Unlisted files are preserved. Removing an app from the manifest or changing its
destination does not delete its old files; cleanup and backup restoration are
manual. Explicitly mapping configuration files means updates replace them too.

The CLI rejects traversal paths, symlink destinations, overlapping paths, and
unknown manifest fields. Selected ZIP contents and downloads have a 128 MiB
limit. It only handles homebrew files under `switch/`; firmware, bootloaders,
sysmodules, and game installation are outside this version's scope.

Ordinary installation failures restore replaced files and remove newly written
files. The lockfile is replaced only after successful app writes. This is **not
a power-loss-safe transaction**: ejecting a card, terminating the process, or
losing power during writes may require manual recovery from backups. Empty
directories can remain after rollback. Do not modify the target concurrently.

Writes use `.switchpack-running` guard directories beside the manifest and at
the target root. A stale guard can remain after an interrupted process. Remove
it only after verifying that no switchpack process is running.

## Development

```sh
bun test
bun run typecheck
bun run build
./dist/switchpack --help
```

The build creates a standalone executable for the current platform. No Bun
installation is required to run that executable. Tests use isolated temporary
directories and simulated GitHub releases; they do not modify a console.
