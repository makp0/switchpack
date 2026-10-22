# switchpack

A TypeScript + Bun CLI for managing Switch homebrew and sysmodule packages through a JSON manifest.
Commander.js handles commands and help; fflate reads ZIP release assets.
Supports DBI over MTP and Hekate USB Mass Storage / mounted SD cards.

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
removing it: open **Hekate → Tools → USB Tools → SD Card**, then use `--target`
with the resulting mounted volume. The CLI also works with an ordinary staging
directory whose files you copy yourself.

## DBI MTP mode

On macOS, install the native dependency and build the small MTP bridge:

```sh
brew install libmtp
bun run build:mtp
```

Linux requires libmtp development headers, `pkg-config`, and a C compiler.
For example, on Debian/Ubuntu install `libmtp-dev pkg-config build-essential`,
then run the same build command. Linux USB permissions must allow your user
to access the device. Windows MTP is not supported by this helper.

Connect one Switch by USB and leave **DBI → Run MTP responder** open:

```sh
bun run cli install --mtp --dry-run
bun run cli install --mtp
bun run cli status --mtp
bun run cli update --mtp
```

Choose exactly one of `--mtp` or `--target`. The helper selects Nintendo's USB
vendor ID and DBI's `1: SD Card` storage; it does not write NAND or other storage.

If macOS Image Capture's `ptpcamerad` has claimed USB, add `--release-camera`:

```sh
bun run cli install --mtp --release-camera
bun run cli status --mtp --release-camera
```

This explicitly stops your user's `ptpcamerad` process immediately before each
USB connection. It may interrupt camera imports; macOS can restart the service.
Other MTP clients should be closed. The CLI never requires sudo or kills the
camera service unless this option is selected.

The default helper is `dist/switchpack-mtp`. A compiled CLI looks for it beside
its executable. Override it with `--mtp-helper /absolute/path/to/switchpack-mtp`.
The helper and its libmtp shared-library dependency are separate from the Bun
executable.

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

For ZIP and 7z archives, `files` maps exact archive filenames to exact SD-relative filenames.
Only listed entries are extracted. ZIP support is built in; 7z support requires
`7zz` or `7z` on PATH (`brew install sevenzip` on macOS). 7z entries are streamed
from 7-Zip into memory; archives are never unpacked directly onto the SD card.
For a direct release asset, replace `files`
with `"destination": "switch/example/example.nro"`. Asset names are exact,
with no wildcard matching. Destinations may be any safe SD-relative file path. The manifest declares exactly
where each file goes; package names and folders are not hardcoded. The target
adapters handle reads and writes, while shared path validation rejects traversal
and switchpack metadata destinations.

`version` accepts `latest` (GitHub's latest stable release) or an exact tag such as
`1.0.8`. Tags are literal: include a leading `v` only if the upstream tag has one.
Semver ranges are not supported.

## Declarative configuration

Each app can declare `configFiles`: SD-relative filenames mapped to exact UTF-8
contents (up to 1 MiB per file). This works for any app or sysmodule and any text
format; switchpack writes whole files rather than interpreting INI/JSON keys.
For example, add this to a USB Botbase app entry:

```json
"configFiles": {
  "atmosphere/contents/430000000000000B/config.cfg": "wifi"
}
```

Config contents override packaged defaults at the same destination. They are
checksummed in the lock, included in `status`, backed up before replacement,
read back after writes, and restored on a failed transaction. `install` applies
settings-only edits offline when the locked binary files are intact. `update`
continues to apply declared settings after installing a newer release. Package
changes still require `update`. Dry runs leave configs and metadata untouched.

Removing a standalone config mapping leaves that file on the SD, unmanaged.
Removing an override of a still-mapped packaged file restores the packaged
default on the next install/update (which requires downloading the locked asset).
Files not declared in either mapping remain untouched. Interactive edits to
managed files are drift: the next install replaces them with declared contents.
Only opt files into management when this is what you want.

The device manifest and local/device lockfiles include the config contents.
Keep passwords and other secrets out of committed manifests. No credentials
are needed for the Botbase mode config. Applying a file does not reload a
running sysmodule or automatically reboot the console.

See [Botbase Wi-Fi example](../examples/botbase-wifi.json).

## Wi-Fi FTP target

The same installation engine supports mounted SD cards (`--target`), USB MTP
(`--mtp`) and Wi-Fi FTP (`--ftp`). Select exactly one. USB Botbase is a controller
protocol, not a filesystem protocol; Wi-Fi installs need Sphaira/ftpsrv or another
FTP server running on the Switch. FTP and USB MTP share a local guard against
concurrent writes from this copy of switchpack.

Sphaira defaults to FTP port 5000 and exposes the SD under `sdmc:`:

```sh
switchpack manifest --ftp ftp://192.168.1.123:5000/sdmc:
switchpack install --ftp ftp://192.168.1.123:5000/sdmc: --dry-run
switchpack install --ftp ftp://192.168.1.123:5000/sdmc:
switchpack status --ftp ftp://192.168.1.123:5000/sdmc:
```

The URL path must name the **SD root**, not the server's virtual mount list.
For servers exposing SD directly, use `/`. Anonymous login is the default; use
`SWITCHPACK_FTP_USER` and `SWITCHPACK_FTP_PASSWORD` for authenticated servers.
Credentials in URLs are rejected. `ftps://` requests explicit TLS with normal
certificate validation; there is no fallback to plaintext. Sphaira's ordinary
FTP is unencrypted: use it only on your trusted LAN.

FTP writes upload to a temporary sibling and verify its contents. Existing files
are renamed aside before replacement because Sphaira refuses overwrite-renames;
failed replacements restore the original. The engine also verifies the final file.
There is a brief gap between the two renames, so avoid power loss during writes. Missing-file checks use directory
listings so permission and connection failures cannot masquerade as absence.
Symbolic links and unsafe relative paths are rejected. This guard coordinates
local processes, not other computers/FTP clients; close those during installs.

## Explicit reboot

```sh
switchpack reboot --ftp ftp://192.168.1.123:5000/sdmc:
```

This sends ftpsrv's `REBT` extension only when explicitly requested. A positive
acknowledgement confirms the request, not successful boot completion. A dropped
connection without acknowledgement is reported as a failure; do not blindly
retry. Standalone ftpsrv implements this extension. Sphaira 1.0.8's embedded FTP
server does **not** register it, and mounted SD / DBI MTP do not expose reboot.
Unsupported servers return an error; no HID sequences or unverified reboot
workarounds are used. Finish transfers and close games before requesting reboot.

## Sysmodule packages (USB botbase example)

The same `apps` entries support sysmodules, overlays, and configuration files; no
new package type or folder allowlist is needed. For example, destinations can be
`atmosphere/contents/<title-id>/exefs.nsp`, `switch/.overlays/example.ovl`, or
`config/example/settings.ini`. Existing homebrew manifests and lockfiles still work.

[`examples/usb-botbase.json`](../examples/usb-botbase.json) pins the upstream
[USB botbase v2.5 release](https://github.com/Koi-3088/usb-botbase/releases/tag/v2.5)
and maps its module and configuration. Its `enableFile` declares the boot flag. Start with a local staging
folder, then use the same manifest with DBI:

```sh
brew install sevenzip
mkdir -p sdroot
bun run cli install --manifest examples/usb-botbase.json --target ./sdroot --dry-run
bun run cli install --manifest examples/usb-botbase.json --target ./sdroot
# When ready to install on the console, leave DBI's MTP responder open:
bun run cli install --manifest examples/usb-botbase.json --mtp --dry-run
bun run cli install --manifest examples/usb-botbase.json --mtp
```

The example has `"enabled": true`, which creates an empty file at `enableFile`,
enabling the module at the next boot. To disable it, edit the app entry:

```json
"enableFile": "atmosphere/contents/430000000000000B/flags/boot2.flag",
"enabled": false
```

Then apply it with the same target, for example:

```sh
bun run cli install --manifest examples/usb-botbase.json --mtp --release-camera
```

Changing only `enabled` reuses the existing lockfile and works offline when the
locked payload is already present and verified. `update` still resolves releases
and refreshes payloads, including disabled packages. Disabling
removes only `enableFile`; module binaries and settings are preserved. Removal is
backed up, verified, and rolled back if installation fails. Status checks that the
flag is absent when disabled. Both fields must be declared together, and the enable
file must not also appear in `files`. This mechanism applies to tools controlled by
an empty presence flag; it does not stop an already running module or change a
setting inside a configuration file.
Restart the console after installation. A successful transfer does not establish
firmware compatibility or runtime stability.
If it fails to boot, use Hekate's SD access to remove this module's
`atmosphere/contents/430000000000000B/flags/boot2.flag`.

Explicitly mapped package configuration files are replaced on updates, with backups of
previous contents. Use `configFiles` for declared settings that override package defaults.
Omit both mappings to preserve an app-managed file. Removing a mapping does not delete files already installed.

## Commands and lockfile

| Command | Behavior |
| --- | --- |
| `install` | Reuse locked releases. Resolve new apps without lock entries. Reject changed app definitions until `update` is run. |
| `update` | Resolve each manifest entry again, download and verify it, and refresh the lockfile. Exact version pins remain pinned. |
| `status` | Compare local files with locked checksums, offline. Report unlocked, changed, missing, or modified apps. |
| `manifest` | Print the discovered manifest as JSON; does not change the device. |

These commands require either `--target` or `--mtp`. The default manifest and
lockfile live on the SD card at `switch/.switchpack/switchpack.json` and
`switch/.switchpack/switchpack.lock.json`. A new computer can run `status`,
`install`, or `update` against that saved setup without any local project files.

If the Switch has no saved manifest, the CLI falls back to `./switchpack.json`.
Use `--manifest path/to/apps.json` to explicitly select a local file instead.
Its local lockfile is `path/to/apps.lock.json`; if absent, the saved Switch lock
is reused. Successful installs and updates save the complete manifest and lock
to the Switch, and also write a local lock when a local manifest was selected.
Keep local copies in Git if desired.

An explicit local manifest replaces the whole saved manifest. Omitted packages
are reported and their files are retained, but they stop being managed. To edit
the saved setup, export it with `switchpack manifest --mtp > my-switch.json`, edit
the file, then apply it with `install --manifest my-switch.json --mtp` (use
`update` when changing package definitions other than `enabled`). On a mounted
card you can edit the saved manifest directly. Status/export never write metadata.

`install` and `update` support `--dry-run`: download and validate everything,
report planned writes, and leave app files and the lockfile untouched. This still
uses the network. MTP dry runs read the device and briefly hold a local USB guard;
`--release-camera`, when selected, also applies to dry runs and status.
`status` does not check whether newer releases exist.

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

In MTP mode, uploads first use a temporary filename and are read back byte for
byte. Only verified uploads replace the existing filename, and the final file
is read back again. The TypeScript manager also verifies the installed checksum
before recording the lockfile. Mounted-SD writes likewise get checksum readback.

Unlisted files are preserved. Removing an app from the manifest or changing its
destination does not delete its old files; cleanup and backup restoration are
manual. Explicitly mapping configuration files means updates replace them too.

The CLI rejects traversal paths, symlink destinations, overlapping paths, and
unknown manifest fields. Selected archive contents and downloads have a 128 MiB
limit. It copies only explicitly mapped files; it does not install games, validate firmware
compatibility, stop running sysmodules, or reboot the console. An incorrect mapping
can replace system configuration, so inspect new manifests with `--dry-run`.

Installation failures attempt to restore replaced files and remove newly written
files. USB disconnection can prevent rollback; errors include the backup location
when rollback fails. On-Switch manifest/lock writes participate in the same
readback, backup, and rollback scope as app files. A local lockfile, when used,
is replaced only after successful device writes. This is **not
a power-loss-safe transaction**: ejecting a card, terminating the process, or
losing power during writes may require manual recovery from backups. Empty
directories can remain after rollback. Do not modify the target concurrently.

Writes use `.switchpack-running` guard directories beside the manifest and at
the mounted target root. MTP operations instead hold `switchpack-mtp-running` in
the OS temporary directory, including reads, to prevent this user's switchpack
processes from contending for USB. A stale guard can remain after an interrupted process. Remove
it only after verifying that no switchpack process is running.

Interrupted MTP uploads may leave `<filename>.switchpack-tmp` (new upload) or
`<filename>.switchpack-before` (previous file) beside the target. The helper
refuses to overwrite these recovery files. Inspect them and the operation's
backups before restoring or removing them manually.

## Development

Tests covering 7z archives require `7zz` or `7z` on PATH.

```sh
bun test
bun run typecheck
bun run build
bun run build:mtp
./dist/switchpack --help
```

The build creates an executable for the current platform. No Bun installation is
required to run it. MTP mode additionally requires the native helper and libmtp.
Tests use isolated temporary directories, simulated GitHub releases, and a
simulated MTP helper; they do not modify a console.
