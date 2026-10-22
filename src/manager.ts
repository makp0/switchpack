import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { relativePath, destination } from "./paths";
import { unzipSync } from "fflate";
import { filesystemTarget, mtpTarget, optionalRead, type Target } from "./target";

type App = { repo: string; version: string; asset: string; destination?: string; files?: Record<string, string>; enableFile?: string; enabled?: boolean };
type LockedApp = { spec: App; tag: string; sha256: string; files: Record<string, string> };
type Lock = { schemaVersion: 1; apps: Record<string, LockedApp> };
export type Options = { manifest?: string; target?: string; mtp?: boolean; mtpHelper?: string; releaseCamera?: boolean; dryRun?: boolean };
export const SWITCH_MANIFEST = "switch/.switchpack/switchpack.json";
export const SWITCH_LOCK = "switch/.switchpack/switchpack.lock.json";
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const MAX_BYTES = 128 * 1024 * 1024;
const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
function fail(message: string): never { throw new Error(message); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function keys(value: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`Unknown field: ${key}`);
}

function parseApp(value: unknown): App {
  if (!record(value)) fail("Each app must be an object");
  keys(value, ["repo", "version", "asset", "destination", "files", "enableFile", "enabled"]);
  if (!text(value.repo) || !/^[\w.-]+\/[\w.-]+$/.test(value.repo)) fail("Expected repo: owner/repository");
  if (!text(value.version) || /[\x00-\x1f]/.test(value.version)) fail("Expected version: latest or an exact release tag");
  relativePath(value.asset);
  if (value.asset.includes("/")) fail("asset must be an exact release filename");
  const app: App = { repo: value.repo, version: value.version, asset: value.asset };
  if (/\.(zip|7z)$/i.test(value.asset)) {
    if (value.destination !== undefined || !record(value.files) || !Object.keys(value.files).length) fail("Archive assets require a nonempty files mapping, without destination");
    const files: Record<string, string> = Object.create(null);
    for (const source of Object.keys(value.files).sort()) {
      relativePath(source);
      const target = value.files[source];
      destination(target);
      files[source] = target;
    }
    app.files = files;
  } else {
    if (value.files !== undefined) fail("files is only supported for ZIP or 7z assets");
    destination(value.destination);
    app.destination = value.destination;
  }
  if (value.enableFile !== undefined || value.enabled !== undefined) {
    destination(value.enableFile);
    if (typeof value.enabled !== "boolean") fail("enableFile requires enabled: true or false");
    app.enableFile = value.enableFile;
    app.enabled = value.enabled;
  }
  return app;
}

const paths = (app: App) => [...(app.files ? Object.values(app.files) : [app.destination!]), ...(app.enableFile && app.enabled ? [app.enableFile] : [])];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function parseManifest(bytes: Uint8Array): Record<string, App> {
  const input: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!record(input)) fail("Manifest must be an object");
  keys(input, ["schemaVersion", "apps"]);
  if (input.schemaVersion !== 1 || !record(input.apps)) fail("Expected schemaVersion: 1 and apps object");
  const apps: Record<string, App> = Object.create(null);
  const targets: string[] = [];
  for (const name of Object.keys(input.apps).sort()) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) fail(`Invalid app name: ${name}`);
    const app = parseApp(input.apps[name]);
    for (const path of [...paths(app), ...(app.enableFile && !app.enabled ? [app.enableFile] : [])]) {
      const lower = path.toLowerCase();
      if (targets.some(other => lower === other || lower.startsWith(other + "/") || other.startsWith(lower + "/"))) fail(`Conflicting destination: ${path}`);
      targets.push(lower);
    }
    apps[name] = app;
  }
  return apps;
}

function parseLock(bytes?: Uint8Array): Lock {
  if (!bytes) return { schemaVersion: 1, apps: Object.create(null) };
  const input: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!record(input) || input.schemaVersion !== 1 || !record(input.apps)) fail("Invalid lockfile");
  const apps: Record<string, LockedApp> = Object.create(null);
  for (const [name, value] of Object.entries(input.apps)) {
    if (!record(value) || !text(value.tag) || !digest(value.sha256) || !record(value.files)) fail(`Invalid lock entry: ${name}`);
    const spec = parseApp(value.spec);
    if (spec.version !== "latest" && spec.version !== value.tag) fail(`Lock tag does not match pinned version: ${name}`);
    const files: Record<string, string> = Object.create(null);
    for (const [path, sha] of Object.entries(value.files)) {
      destination(path);
      if (!digest(sha)) fail(`Invalid file checksum: ${name}`);
      files[path] = sha;
    }
    if (!same(Object.keys(files).sort(), paths(spec).sort())) fail(`Lock file list does not match manifest: ${name}`);
    apps[name] = { spec, tag: value.tag, sha256: value.sha256, files };
  }
  return { schemaVersion: 1, apps };
}

async function responseBytes(response: Response): Promise<Uint8Array> {
  if (!response.ok) fail(`HTTP ${response.status} ${response.statusText}`);
  if (!response.body) fail("Empty HTTP response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) fail("Download exceeds 128 MiB limit");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

async function sevenZip(data: Uint8Array, mapping: Record<string, string>): Promise<Record<string, Uint8Array>> {
  const executable = Bun.which("7zz") ?? Bun.which("7z");
  if (!executable) fail("7z assets require 7-Zip: brew install sevenzip (macOS), or install 7zz/7z on your PATH");
  const temp = await mkdtemp(join(tmpdir(), "switchpack-7z-"));
  try {
    const archive = join(temp, "package.7z");
    await writeFile(archive, data);
    async function invoke(args: string[]) {
      const child = Bun.spawn([executable!, ...args, "-spd", "-p", "--", archive], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120_000,
      });
      try {
        const [bytes, error, code] = await Promise.all([
          responseBytes(new Response(child.stdout)),
          responseBytes(new Response(child.stderr)), child.exited,
        ]);
        if (code !== 0) fail(`7-Zip failed: ${new TextDecoder().decode(error).trim() || `exit ${code}`}`);
        return bytes;
      } finally { child.kill(); await child.exited; }
    }
    const listing = new TextDecoder().decode(await invoke(["l", "-slt", "-ba"]));
    const entries = listing.split(/\r?\n\r?\n/);
    const files: Record<string, Uint8Array> = Object.create(null);
    let expanded = 0;
    for (const [source, target] of Object.entries(mapping)) {
      const matches = entries.filter(entry => entry.split(/\r?\n/).includes(`Path = ${source}`));
      if (matches.length !== 1) fail(`7z entry missing or duplicated: ${source}`);
      const entry = matches[0]!;
      if (/^Attributes = .*D/m.test(entry) || /^Folder = \+/m.test(entry)) fail(`Expected archive file: ${source}`);
      const size = Number(/^Size = (\d+)\r?$/m.exec(entry)?.[1] ?? NaN);
      expanded += size;
      if (!Number.isSafeInteger(size) || expanded > MAX_BYTES) fail("Selected archive files exceed 128 MiB limit");
      const bytes = await invoke(["x", "-so", `-i!${source}`]);
      if (bytes.length !== size) fail(`7z entry size mismatch: ${source}`);
      files[target] = bytes;
    }
    return files;
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function release(app: App, fetcher: Fetcher): Promise<{ tag: string; sha256?: string }> {
  const endpoint = app.version === "latest" ? "latest" : `tags/${encodeURIComponent(app.version)}`;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "switchpack" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetcher(`https://api.github.com/repos/${app.repo}/releases/${endpoint}`, { headers, signal: AbortSignal.timeout(30_000) });
  const data: unknown = JSON.parse(new TextDecoder().decode(await responseBytes(response)));
  if (!record(data) || !text(data.tag_name) || !Array.isArray(data.assets)) fail("Invalid GitHub release response");
  if (app.version !== "latest" && app.version !== data.tag_name) fail("GitHub release tag does not match the pinned version");
  if (data.draft || (app.version === "latest" && data.prerelease)) fail("Expected a published stable release");
  const asset = data.assets.find(item => record(item) && item.name === app.asset);
  if (!record(asset)) fail(`Asset ${app.asset} missing from ${app.repo}@${data.tag_name}`);
  const sha = typeof asset.digest === "string" ? asset.digest.replace(/^sha256:/, "") : undefined;
  if (sha !== undefined && !digest(sha)) fail("Unsupported GitHub asset digest");
  return { tag: data.tag_name, sha256: sha };
}

export async function run(command: "install" | "update" | "status" | "manifest", options: Options, fetcher: Fetcher = fetch, injectedTarget?: Target): Promise<string[]> {
  if (Boolean(options.target) === Boolean(options.mtp)) fail("Choose exactly one of --target (Hekate/mounted SD) or --mtp (DBI)");
  const target = injectedTarget ?? (options.mtp ? mtpTarget(options.mtpHelper, options.releaseCamera) : await filesystemTarget(options.target!));
  const readonly = command === "status" || command === "manifest" || options.dryRun;
  const guards: string[] = [];
  async function acquire(path: string) {
    if (guards.includes(path)) return;
    try { await mkdir(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") fail(`Another operation may be running: ${path}. Remove this directory only if no switchpack process is running.`);
      throw error;
    }
    guards.push(path);
  }
  try {
    if (options.mtp || !readonly) await acquire(target.guard);
    const savedManifest = await target.read(SWITCH_MANIFEST);
    const savedLock = await target.read(SWITCH_LOCK);
    // The Switch is authoritative unless a local manifest was explicitly selected.
    let manifestPath: string | undefined;
    if (options.manifest || !savedManifest) {
      const requested = resolve(options.manifest ?? "switchpack.json");
      manifestPath = join(await realpath(dirname(requested)), basename(requested));
      if (!readonly) await acquire(join(dirname(manifestPath), ".switchpack-running"));
    }
    const manifestBytes = manifestPath ? await optionalRead(manifestPath) : savedManifest;
    if (!manifestBytes) fail("No manifest found on this Switch or locally. Run switchpack init, then install --manifest switchpack.json with your connection options.");
    const apps = parseManifest(manifestBytes);
    if (command === "manifest") return [JSON.stringify({ schemaVersion: 1, apps }, null, 2)];
    const lockPath = manifestPath ? manifestPath.replace(/\.json$/, "") + ".lock.json" : undefined;
    const previous = parseLock((lockPath ? await optionalRead(lockPath) : undefined) ?? savedLock);
    const messages: string[] = [];
    const next: Lock = { schemaVersion: 1, apps: Object.create(null) };
    const writes: { path: string; data?: Uint8Array; before?: Uint8Array }[] = [];
    for (const [name, app] of Object.entries(apps)) {
      const locked = previous.apps[name];
      const matches = locked && same(app, locked.spec);
      if (command === "status") {
        if (!matches) { messages.push(`${name}: ${locked ? "manifest changed; run update" : "unlocked; run install"}`); continue; }
        const states = [];
        for (const [path, sha] of Object.entries(locked.files)) {
          const bytes = await target.read(path);
          states.push(!bytes ? "missing" : hash(bytes) === sha ? "ok" : "modified");
        }
        if (app.enableFile && !app.enabled && await target.read(app.enableFile)) states.push("enable file present; expected disabled");
        messages.push(`${name}@${locked.tag}: ${states.every(state => state === "ok") ? "ok" : states.filter(state => state !== "ok").join(", ")}`);
        continue;
      }
      // Only skip downloads for install when the locked payload is already present and intact.
      const sameRelease = locked && same({ ...app, enabled: undefined }, { ...locked.spec, enabled: undefined });
      let payloadMatches = true;
      if (command === "install" && locked && sameRelease && app.enableFile && (!matches || !app.enabled)) {
        for (const [path, sha] of Object.entries(locked.files)) {
          if (path === app.enableFile) continue;
          const bytes = await target.read(path);
          if (!bytes || hash(bytes) !== sha) payloadMatches = false;
        }
      }
      if (command === "install" && locked && sameRelease && app.enableFile && (!matches || !app.enabled) && payloadMatches) {
        const checksums = { ...locked.files };
        const before = await target.read(app.enableFile);
        const data = app.enabled ? new Uint8Array() : undefined;
        const changed = app.enabled ? !before || before.length !== 0 : before !== undefined;
        if (changed) writes.push({ path: app.enableFile, data, before });
        if (app.enabled) checksums[app.enableFile] = hash(data!);
        else delete checksums[app.enableFile];
        next.apps[name] = { ...locked, spec: app, files: checksums };
        messages.push(`${name}@${locked.tag}: ${app.enabled ? "enabled" : "disabled"}${changed ? " (enable file to " + (app.enabled ? "write" : "remove") + ")" : ""}`);
        continue;
      }
      if (locked && !matches && !sameRelease && command === "install") fail(`${name}: manifest changed; run update to refresh the lockfile`);
      const resolved = command === "install" && locked && sameRelease ? locked : await release(app, fetcher);
      const url = `https://github.com/${app.repo}/releases/download/${encodeURIComponent(resolved.tag)}/${encodeURIComponent(app.asset)}`;
      const data = await responseBytes(await fetcher(url, { signal: AbortSignal.timeout(120_000) }));
      const sha256 = hash(data);
      if (resolved.sha256 && sha256 !== resolved.sha256) fail(`${name}: asset checksum mismatch`);
      const files: Record<string, Uint8Array> = Object.create(null);
      if (app.files && app.asset.toLowerCase().endsWith(".7z")) {
        Object.assign(files, await sevenZip(data, app.files));
      } else if (app.files) {
        let expanded = 0;
        const seen = new Set<string>();
        const entries = unzipSync(data, { filter(entry) {
          if (!Object.hasOwn(app.files!, entry.name)) return false;
          if (seen.has(entry.name)) fail(`Duplicate ZIP entry: ${entry.name}`);
          seen.add(entry.name);
          expanded += entry.originalSize;
          if (expanded > MAX_BYTES) fail("Selected ZIP files exceed 128 MiB limit");
          return true;
        } });
        for (const [source, target] of Object.entries(app.files)) {
          const bytes = entries[source];
          if (!bytes) fail(`${name}: ZIP entry missing: ${source}`);
          files[target] = bytes;
        }
      } else files[app.destination!] = data;
      if (app.enableFile && app.enabled) files[app.enableFile] = new Uint8Array();
      const checksums: Record<string, string> = Object.create(null);
      let changed = 0;
      for (const [path, bytes] of Object.entries(files)) {
        checksums[path] = hash(bytes);
        if (command === "install" && locked && sameRelease && path !== app.enableFile && checksums[path] !== locked.files[path]) fail(`${name}: locked file checksum mismatch`);
        const before = await target.read(path);
        if (!before || hash(before) !== checksums[path]) { writes.push({ path, data: bytes, before }); changed++; }
      }
      if (app.enableFile && !app.enabled) {
        const before = await target.read(app.enableFile);
        if (before !== undefined) { writes.push({ path: app.enableFile, before }); changed++; }
      }
      next.apps[name] = { spec: app, tag: resolved.tag, sha256, files: checksums };
      messages.push(`${name}@${resolved.tag}: ${changed ? `${changed} file change(s)` : "up to date"}`);
    }
    if (command === "status") return messages;
    if (savedManifest && manifestPath) {
      const removed = Object.keys(parseManifest(savedManifest)).filter(name => !Object.hasOwn(apps, name));
      if (removed.length) messages.push(`Saved manifest replacement stops managing: ${removed.join(", ")}. Their installed files are preserved.`);
    }
    if (options.dryRun) return [...messages, "Dry run: no files or lockfile written."];
    // Persist the manifest and lock on the device in the same rollback scope as app files.
    for (const [path, data, before] of [
      [SWITCH_MANIFEST, Buffer.from(JSON.stringify({ schemaVersion: 1, apps }, null, 2) + "\n"), savedManifest],
      [SWITCH_LOCK, Buffer.from(JSON.stringify(next, null, 2) + "\n"), savedLock],
    ] as const) {
      if (!before || hash(before) !== hash(data)) writes.push({ path, data, before });
    }
    const id = `${Date.now()}-${randomUUID()}`;
    const backupBase = `switch/.switchpack/backups/${id}`;
    // Back up replacements and enable-file removals before changing the target.
    for (const item of writes) if (item.before) {
      await target.write(`${backupBase}/${item.path}`, item.before, true);
    }
    const applied: typeof writes = [];
    const temporaryLock = lockPath ? `${lockPath}.${id}.tmp` : undefined;
    try {
      for (const item of writes) {
        applied.push(item);
        if (item.data !== undefined) await target.write(item.path, item.data);
        else await target.remove(item.path);
        const readback = await target.read(item.path);
        if (item.data !== undefined ? !readback || hash(readback) !== hash(item.data) : readback !== undefined) fail(`Installed file readback mismatch: ${item.path}`);
      }
      if (temporaryLock && lockPath) {
        await writeFile(temporaryLock, JSON.stringify(next, null, 2) + "\n", { flag: "wx" });
        await rename(temporaryLock, lockPath);
      }
    } catch (error) {
      const failures: string[] = [];
      for (const item of applied.reverse()) {
        try {
          if (item.before) {
            await target.write(item.path, item.before);
            const readback = await target.read(item.path);
            if (!readback || hash(readback) !== hash(item.before)) fail(`Rollback readback mismatch: ${item.path}`);
          } else await target.remove(item.path);
        } catch { failures.push(item.path); }
      }
      if (failures.length) fail(`Installation failed and rollback failed for ${failures.join(", ")}. Backups: ${target.describe(backupBase)}. Original error: ${String(error)}`);
      throw error;
    } finally { if (temporaryLock) await rm(temporaryLock, { force: true }); }
    if (writes.some(item => item.before)) messages.push(`Backups: ${target.describe(backupBase)}`);
    messages.push(`Switch manifest: ${target.describe(SWITCH_MANIFEST)}`);
    if (lockPath) messages.push(`Local lockfile: ${lockPath}`);
    return messages;
  } finally {
    for (const path of guards.reverse()) await rm(path, { recursive: true });
  }
}
