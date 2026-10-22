import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { filesystemTarget, mtpTarget, optionalRead, type Target } from "./target";

type App = { repo: string; version: string; asset: string; destination?: string; files?: Record<string, string> };
type LockedApp = { spec: App; tag: string; sha256: string; files: Record<string, string> };
type Lock = { schemaVersion: 1; apps: Record<string, LockedApp> };
export type Options = { manifest: string; target?: string; mtp?: boolean; mtpHelper?: string; releaseCamera?: boolean; dryRun?: boolean };
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

function relativePath(value: unknown): asserts value is string {
  if (!text(value) || /[\\:<>"|?*\x00-\x1f]/.test(value) ||
      value.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part))) {
    fail(`Unsafe relative path: ${String(value)}`);
  }
}

function destination(value: unknown): asserts value is string {
  relativePath(value);
  // Keep this first version scoped to homebrew apps, away from firmware and saves.
  if (!value.startsWith("switch/") || value.toLowerCase().startsWith("switch/.switchpack/")) {
    fail(`Destination must be a file under switch/: ${value}`);
  }
}

function parseApp(value: unknown): App {
  if (!record(value)) fail("Each app must be an object");
  keys(value, ["repo", "version", "asset", "destination", "files"]);
  if (!text(value.repo) || !/^[\w.-]+\/[\w.-]+$/.test(value.repo)) fail("Expected repo: owner/repository");
  if (!text(value.version) || /[\x00-\x1f]/.test(value.version)) fail("Expected version: latest or an exact release tag");
  relativePath(value.asset);
  if (value.asset.includes("/")) fail("asset must be an exact release filename");
  const app: App = { repo: value.repo, version: value.version, asset: value.asset };
  if (value.asset.toLowerCase().endsWith(".zip")) {
    if (value.destination !== undefined || !record(value.files) || !Object.keys(value.files).length) fail("ZIP assets require a nonempty files mapping, without destination");
    const files: Record<string, string> = Object.create(null);
    for (const source of Object.keys(value.files).sort()) {
      relativePath(source);
      const target = value.files[source];
      destination(target);
      files[source] = target;
    }
    app.files = files;
  } else {
    if (value.files !== undefined) fail("files is only supported for ZIP assets");
    destination(value.destination);
    app.destination = value.destination;
  }
  return app;
}

const paths = (app: App) => app.files ? Object.values(app.files) : [app.destination!];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function manifestAt(path: string): Promise<Record<string, App>> {
  const input: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!record(input)) fail("Manifest must be an object");
  keys(input, ["schemaVersion", "apps"]);
  if (input.schemaVersion !== 1 || !record(input.apps)) fail("Expected schemaVersion: 1 and apps object");
  const apps: Record<string, App> = Object.create(null);
  const targets: string[] = [];
  for (const name of Object.keys(input.apps).sort()) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) fail(`Invalid app name: ${name}`);
    const app = parseApp(input.apps[name]);
    for (const path of paths(app)) {
      const lower = path.toLowerCase();
      if (targets.some(other => lower === other || lower.startsWith(other + "/") || other.startsWith(lower + "/"))) fail(`Conflicting destination: ${path}`);
      targets.push(lower);
    }
    apps[name] = app;
  }
  return apps;
}

async function lockAt(path: string): Promise<Lock> {
  const bytes = await optionalRead(path);
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

export async function run(command: "install" | "update" | "status", options: Options, fetcher: Fetcher = fetch, injectedTarget?: Target): Promise<string[]> {
  const requestedManifest = resolve(options.manifest);
  const manifestPath = join(await realpath(dirname(requestedManifest)), basename(requestedManifest));
  const lockPath = manifestPath.replace(/\.json$/, "") + ".lock.json";
  if (Boolean(options.target) === Boolean(options.mtp)) fail("Choose exactly one of --target (Hekate/mounted SD) or --mtp (DBI)");
  const target = injectedTarget ?? (options.mtp ? mtpTarget(options.mtpHelper, options.releaseCamera) : await filesystemTarget(options.target!));
  const guard = join(dirname(manifestPath), ".switchpack-running");
  // The target guard also prevents different manifests from writing the same card concurrently.
  const targetGuard = target.guard;
  const guards: string[] = [];
  try {
    if (options.mtp || (command !== "status" && !options.dryRun)) {
      const neededGuards = command === "status" || options.dryRun ? [targetGuard] : [guard, targetGuard];
      for (const path of new Set(neededGuards)) {
        try { await mkdir(path); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") fail(`Another operation may be running: ${path}. Remove this directory only if no switchpack process is running.`);
          throw error;
        }
        guards.push(path);
      }
    }
    const apps = await manifestAt(manifestPath);
    const previous = await lockAt(lockPath);
    const messages: string[] = [];
    const next: Lock = { schemaVersion: 1, apps: Object.create(null) };
    const writes: { path: string; data: Uint8Array; before?: Uint8Array }[] = [];
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
        messages.push(`${name}@${locked.tag}: ${states.every(state => state === "ok") ? "ok" : states.filter(state => state !== "ok").join(", ")}`);
        continue;
      }
      if (locked && !matches && command === "install") fail(`${name}: manifest changed; run update to refresh the lockfile`);
      const resolved = command === "install" && matches ? locked : await release(app, fetcher);
      const url = `https://github.com/${app.repo}/releases/download/${encodeURIComponent(resolved.tag)}/${encodeURIComponent(app.asset)}`;
      const data = await responseBytes(await fetcher(url, { signal: AbortSignal.timeout(120_000) }));
      const sha256 = hash(data);
      if (resolved.sha256 && sha256 !== resolved.sha256) fail(`${name}: asset checksum mismatch`);
      const files: Record<string, Uint8Array> = Object.create(null);
      if (app.files) {
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
      const checksums: Record<string, string> = Object.create(null);
      let changed = 0;
      for (const [path, bytes] of Object.entries(files)) {
        checksums[path] = hash(bytes);
        if (command === "install" && matches && checksums[path] !== locked.files[path]) fail(`${name}: locked file checksum mismatch`);
        const before = await target.read(path);
        if (!before || hash(before) !== checksums[path]) { writes.push({ path, data: bytes, before }); changed++; }
      }
      next.apps[name] = { spec: app, tag: resolved.tag, sha256, files: checksums };
      messages.push(`${name}@${resolved.tag}: ${changed ? `${changed} file(s) to write` : "up to date"}`);
    }
    if (command === "status") return messages;
    if (options.dryRun) return [...messages, "Dry run: no files or lockfile written."];
    const id = `${Date.now()}-${randomUUID()}`;
    const backupBase = `switch/.switchpack/backups/${id}`;
    // Back up everything before the first app write. No files are deleted on update.
    for (const item of writes) if (item.before) {
      await target.write(`${backupBase}/${item.path}`, item.before, true);
    }
    const applied: typeof writes = [];
    const temporaryLock = `${lockPath}.${id}.tmp`;
    try {
      for (const item of writes) {
        applied.push(item);
        await target.write(item.path, item.data);
        const readback = await target.read(item.path);
        if (!readback || hash(readback) !== hash(item.data)) fail(`Installed file readback mismatch: ${item.path}`);
      }
      await writeFile(temporaryLock, JSON.stringify(next, null, 2) + "\n", { flag: "wx" });
      await rename(temporaryLock, lockPath);
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
    } finally { await rm(temporaryLock, { force: true }); }
    if (writes.some(item => item.before)) messages.push(`Backups: ${target.describe(backupBase)}`);
    messages.push(`Lockfile: ${lockPath}`);
    return messages;
  } finally {
    for (const path of guards.reverse()) await rm(path, { recursive: true });
  }
}
