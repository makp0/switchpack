# switchpack

[![CI](https://github.com/makp0/switchpack/actions/workflows/ci.yml/badge.svg)](https://github.com/makp0/switchpack/actions/workflows/ci.yml)

Keep your Nintendo Switch homebrew apps and sysmodules in one file. Install them, pin versions,
and update them together—much like dependencies in `package.json`.

switchpack runs on your computer. It downloads GitHub release assets, verifies
checksums, and copies the files you choose to your Switch. It supports **DBI over
USB MTP** and **Hekate USB Mass Storage / mounted SD cards**.

## Install

```sh
brew install makp0/tap/switchpack
```

Supports macOS 15+ (Apple silicon or Intel) and Linux (ARM64 or x64).
Homebrew installs the USB dependencies and helper automatically; you don't need
Bun. Upgrade the CLI with `brew upgrade switchpack`.

You can also [download a release](https://github.com/makp0/switchpack/releases).
Direct downloads include the CLI and MTP helper source; see the
[source build instructions](docs/reference.md#dbi-mtp-mode) for MTP setup.

## First install

```sh
mkdir my-switch && cd my-switch
switchpack init
```

This creates `switchpack.json`, initially containing Sphaira. Review the file,
then choose how to connect your Switch.

### DBI over USB

Connect the Switch and open **DBI → Run MTP responder**. Keep it open:

```sh
switchpack install --mtp --dry-run
switchpack install --mtp
switchpack status --mtp
```

If macOS reports that USB is busy, close other MTP clients and add
`--release-camera`. This stops your user's camera service before each connection
and can interrupt camera imports:

```sh
switchpack install --mtp --release-camera
```

### Hekate or a card reader

In Hekate, open **Tools → USB Tools → SD Card**. Your computer should mount
the card as a drive. A card reader also works. Replace the path with yours:

```sh
switchpack install --target /Volumes/SWITCH --dry-run
switchpack install --target /Volumes/SWITCH
switchpack status --target /Volumes/SWITCH
```

On Linux, use your mount point, such as `/media/your-user/SWITCH`.
You can try these commands against an empty local folder first.

## Declare your apps

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

- `repo`: the upstream GitHub repository.
- `version`: `latest` for its latest stable release, or an exact tag to pin it.
- `asset`: the exact release filename.
- `files`: map ZIP or 7z filenames on the left to SD paths on the right.

For a direct `.nro` asset, use `"destination": "switch/app/app.nro"` instead
of `files`. Only listed files are installed. Destinations can be any safe
SD-relative file path, including `atmosphere/contents/`, `config/`, and overlays.
ZIP support is built in; 7z archives require `7zz` or `7z` on PATH.

The first install creates `switchpack.lock.json` with exact release tags and
SHA-256 checksums. Keep both files in Git to reproduce your setup.

## Sysmodules and boot flags

The [USB botbase example](examples/usb-botbase.json) pins v2.5 and maps its module
and configuration files to `atmosphere/contents/430000000000000B/`. Try it in a
staging folder before installing it on a console:

```sh
cp "$(brew --prefix)/share/switchpack/examples/usb-botbase.json" ./usb-botbase.json
mkdir -p sdroot
switchpack install --manifest usb-botbase.json --target sdroot --dry-run
```

When running from a source checkout, use `examples/usb-botbase.json` directly.

Packages controlled by a presence flag can declare:

```json
"enableFile": "atmosphere/contents/430000000000000B/flags/boot2.flag",
"enabled": false
```

`enabled: true` creates an empty boot flag; `false` removes it while preserving
the module and configuration. Apply changes with `install` using the same
manifest and connection options. Changing only `enabled` can work offline when
the locked payload is already installed and verified. Reboot the console for
boot-flag changes to take effect; this does not stop a running module.

Configuration files explicitly listed in `files` are replaced during updates.
Omit their mappings to preserve your own settings. See the
[full sysmodule example](docs/reference.md#sysmodule-packages-usb-botbase-example).

## Update

```sh
switchpack update --mtp --dry-run
switchpack update --mtp
```

Use `--target <path>` instead of `--mtp` for a mounted card.

| Command | What it does |
| --- | --- |
| `init` | Create a starter manifest; never overwrite an existing one. |
| `install` | Install locked releases; resolve apps without lock entries. |
| `update` | Resolve the manifest again and refresh installed files and lockfile. |
| `status` | Check installed files against the lockfile without contacting GitHub. |

Use `--manifest path/to/apps.json` for another setup, or `--help` for options.
Changed package definitions require `update`, except for `enabled` changes.
Removing a package from the manifest
does not delete its files.

## Backups and limits

Replaced files are backed up on the SD card under
`switch/.switchpack/backups/<operation-id>/`. Unlisted files stay untouched.
Installed files are read back and checked before the lockfile is saved.

Failed installs attempt rollback. A disconnected cable or power loss can prevent
recovery; inspect the backups before retrying. See
[recovery and troubleshooting](docs/reference.md#file-handling).

Downloads and each archive's selected contents have a 128 MiB limit. Incorrect
destination mappings can replace system configuration. switchpack does not
validate firmware compatibility, stop running sysmodules, reboot the console,
or install games. Windows is not supported.

## Development

Requires Bun 1.3.14+, a C compiler, libmtp development headers, and 7-Zip.

```sh
git clone https://github.com/makp0/switchpack.git
cd switchpack
bun install --frozen-lockfile
brew install libmtp sevenzip # Linux: install libmtp-dev, pkg-config, and 7zip
bun test
bun run typecheck
bun run build
bun run build:mtp
./dist/switchpack --help
```

Tests use temporary folders and a simulated MTP helper; they never write to
a console. CI checks four OS/architecture combinations and builds release
archives. See the [full reference](docs/reference.md) and
[release instructions](docs/releasing.md).

MIT licensed. See [third-party notices](THIRD_PARTY_NOTICES.md).
