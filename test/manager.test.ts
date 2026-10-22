import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { run, SWITCH_MANIFEST, SWITCH_LOCK } from "../src/manager";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

async function fixture(zip = false) {
  const root = await mkdtemp(join(tmpdir(), "switchpack-test-"));
  roots.push(root);
  const target = join(root, "sd");
  await mkdir(target);
  const manifest = join(root, "switchpack.json");
  const lock = join(root, "switchpack.lock.json");
  const app = zip
    ? { repo: "example/app", version: "latest", asset: "app.zip", files: { "dist/app.nro": "switch/app/app.nro" } }
    : { repo: "example/app", version: "latest", asset: "app.nro", destination: "switch/app/app.nro" };
  const save = async (apps: unknown = { app }) => writeFile(manifest, JSON.stringify({ schemaVersion: 1, apps }));
  await save();
  let tag = "v1";
  let bytes = new TextEncoder().encode("first release");
  let calls: string[] = [];
  const asset = () => zip ? zipSync({ "dist/app.nro": bytes, "config/settings.ini": new TextEncoder().encode("do not copy") }) : bytes;
  const fetcher = async (url: string) => {
    calls.push(url);
    if (url.startsWith("https://api.github.com/")) return Response.json({ tag_name: tag, assets: [{ name: app.asset, digest: `sha256:${sha(asset())}` }] });
    return new Response(asset());
  };
  return {
    root, target, manifest, lock, app, save, fetcher, calls,
    options: { manifest, target },
    file: join(target, "switch/app/app.nro"),
    bump() { tag = "v2"; bytes = new TextEncoder().encode("second release"); },
  };
}

test("installs, locks, reinstalls exact release without API resolution, updates and backs up", async () => {
  const f = await fixture();
  await run("install", f.options, f.fetcher);
  expect(await readFile(f.file, "utf8")).toBe("first release");
  expect(JSON.parse(await readFile(f.lock, "utf8")).apps.app.tag).toBe("v1");
  f.calls.length = 0;
  await run("install", f.options, f.fetcher);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toContain("/download/v1/");
  f.bump();
  await run("update", f.options, f.fetcher);
  expect(await readFile(f.file, "utf8")).toBe("second release");
  const backups = join(f.target, "switch/.switchpack/backups");
  const [backup] = await readdir(backups);
  expect(await readFile(join(backups, backup!, "switch/app/app.nro"), "utf8")).toBe("first release");
});

test("status is offline and detects missing and locally modified files", async () => {
  const f = await fixture();
  await run("install", f.options, f.fetcher);
  const offline = async (): Promise<Response> => { throw new Error("Network must not be used"); };
  expect(await run("status", f.options, offline)).toEqual(["app@v1: ok"]);
  await writeFile(f.file, "local edit");
  expect(await run("status", f.options, offline)).toEqual(["app@v1: modified"]);
  await rm(f.file);
  expect(await run("status", f.options, offline)).toEqual(["app@v1: missing"]);
});

test("dry run downloads and validates but writes nothing", async () => {
  const f = await fixture();
  await run("install", { ...f.options, dryRun: true }, f.fetcher);
  expect(await readdir(f.target)).toEqual([]);
  expect(await Bun.file(f.lock).exists()).toBe(false);
  expect((await readdir(f.root)).sort()).toEqual(["sd", "switchpack.json"]);
});

test("only explicitly mapped ZIP files are installed", async () => {
  const f = await fixture(true);
  await run("install", f.options, f.fetcher);
  expect(await readFile(f.file, "utf8")).toBe("first release");
  expect(await readdir(f.target)).toEqual(["switch"]);
});

test("changed manifests require update and exact tags use the tag endpoint", async () => {
  const f = await fixture();
  await run("install", f.options, f.fetcher);
  f.app.version = "v1";
  await f.save();
  await expect(run("install", f.options, f.fetcher)).rejects.toThrow("manifest changed");
  f.calls.length = 0;
  await run("update", f.options, f.fetcher);
  expect(f.calls[0]).toEndWith("/tags/v1");
});

test("checksum mismatch prevents writes and keeps the previous lock", async () => {
  const f = await fixture();
  await run("install", f.options, f.fetcher);
  const before = await readFile(f.lock, "utf8");
  f.bump();
  await expect(run("install", f.options, f.fetcher)).rejects.toThrow("checksum mismatch");
  expect(await readFile(f.file, "utf8")).toBe("first release");
  expect(await readFile(f.lock, "utf8")).toBe(before);
});

test("unsafe paths, overlapping destinations and unknown fields are rejected", async () => {
  const f = await fixture();
  for (const destination of ["../outside", "/switch/app.nro", "switch/../save", "switch/x\\y", "switch/x./file"]) {
    await f.save({ app: { ...f.app, destination } });
    await expect(run("install", f.options, f.fetcher)).rejects.toThrow();
  }
  await f.save({ app: f.app, other: { ...f.app, destination: "switch/App/app.nro" } });
  await expect(run("install", f.options, f.fetcher)).rejects.toThrow("Conflicting");
  await f.save({ app: { ...f.app, typo: true } });
  await expect(run("install", f.options, f.fetcher)).rejects.toThrow("Unknown field");
  expect(f.calls).toHaveLength(0);
});

test("symlinks cannot redirect installation outside the target", async () => {
  const f = await fixture();
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await symlink(outside, join(f.target, "switch"));
  await expect(run("install", f.options, f.fetcher)).rejects.toThrow("symlink");
  expect(await readdir(outside)).toEqual([]);
});

test("all downloads are verified before modifying any app", async () => {
  const f = await fixture();
  await f.save({ app: f.app, second: { ...f.app, destination: "switch/second.nro", asset: "missing.nro" } });
  await expect(run("install", f.options, f.fetcher)).rejects.toThrow("missing");
  expect(await readdir(f.target)).toEqual([]);
  expect(await Bun.file(f.lock).exists()).toBe(false);
});

test("lock write failure rolls back overwritten and newly created files", async () => {
  const f = await fixture();
  await mkdir(join(f.target, "switch/app"), { recursive: true });
  await writeFile(f.file, "original");
  await f.save({ app: f.app, second: { ...f.app, destination: "switch/new.nro" } });
  const fetcher = async (url: string) => {
    if (url.startsWith("https://github.com/")) await mkdir(f.lock, { recursive: true });
    return f.fetcher(url);
  };
  await expect(run("install", f.options, fetcher)).rejects.toThrow();
  expect(await readFile(f.file, "utf8")).toBe("original");
  expect(await Bun.file(join(f.target, "switch/new.nro")).exists()).toBe(false);
  expect(await readdir(f.root)).not.toContain(".switchpack-running");
});

test("a busy target is refused without removing another process's guard", async () => {
  const f = await fixture();
  const guard = join(f.target, ".switchpack-running");
  await mkdir(guard);
  await expect(run("install", f.options, f.fetcher)).rejects.toThrow("Another operation");
  expect(await readdir(f.target)).toEqual([".switchpack-running"]);
  expect(f.calls).toHaveLength(0);
});

test("upstream digest mismatch and missing ZIP entries fail before writes", async () => {
  const f = await fixture(true);
  const badDigest = async (url: string) => url.startsWith("https://api.github.com/")
    ? Response.json({ tag_name: "v1", assets: [{ name: "app.zip", digest: `sha256:${"0".repeat(64)}` }] })
    : f.fetcher(url);
  await expect(run("install", f.options, badDigest)).rejects.toThrow("checksum mismatch");
  await f.save({ app: { ...f.app, files: { "absent.nro": "switch/app/app.nro" } } });
  await expect(run("install", f.options, f.fetcher)).rejects.toThrow("ZIP entry missing");
  expect(await readdir(f.target)).toEqual([]);
});

test("manifest and target can share the same directory", async () => {
  const f = await fixture();
  await run("install", { ...f.options, target: f.root }, f.fetcher);
  expect(await readFile(join(f.root, "switch/app/app.nro"), "utf8")).toBe("first release");
});

test("CLI framework provides help and rejects a missing target", async () => {
  const cli = join(import.meta.dir, "../src/cli.ts");
  const help = Bun.spawnSync([process.execPath, cli, "--help"]);
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("install");
  const missing = Bun.spawnSync([process.execPath, cli, "install"]);
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr.toString()).toContain("Choose exactly one");
});

test("init creates a starter manifest and preserves existing files", async () => {
  const f = await fixture();
  const cli = join(import.meta.dir, "../src/cli.ts");
  const manifest = join(f.root, "starter.json");
  const first = Bun.spawnSync([process.execPath, cli, "init", "--manifest", manifest]);
  expect(first.exitCode).toBe(0);
  expect(JSON.parse(await readFile(manifest, "utf8")).apps.sphaira.repo).toBe("NaGaa95/sphaira");
  await writeFile(manifest, "keep my settings");
  const second = Bun.spawnSync([process.execPath, cli, "init", "--manifest", manifest]);
  expect(second.exitCode).toBe(1);
  expect(await readFile(manifest, "utf8")).toBe("keep my settings");
});


test("arbitrary SD-relative package destinations install, update, back up and report status", async () => {
  const f = await fixture();
  const destination = "atmosphere/contents/430000000000000B/exefs.nsp";
  await f.save({ botbase: { ...f.app, destination } });
  await run("install", { ...f.options, dryRun: true }, f.fetcher);
  expect(await readdir(f.target)).toEqual([]);
  await run("install", f.options, f.fetcher);
  expect(await readFile(join(f.target, destination), "utf8")).toBe("first release");
  expect(await run("status", f.options, f.fetcher)).toEqual(["botbase@v1: ok"]);
  f.bump();
  await run("update", f.options, f.fetcher);
  const backups = join(f.target, "switch/.switchpack/backups");
  const [backup] = await readdir(backups);
  expect(await readFile(join(backups, backup!, destination), "utf8")).toBe("first release");
  await f.save({ botbase: { ...f.app, destination: "custom-package.bin" } });
  await run("update", f.options, f.fetcher);
  expect(await readFile(join(f.target, "custom-package.bin"), "utf8")).toBe("second release");
});

test("ZIP packages install empty boot flags and config alongside sysmodules", async () => {
  const f = await fixture(true);
  const base = "atmosphere/contents/430000000000000B";
  const files = { [`${base}/exefs.nsp`]: new TextEncoder().encode("module"), [`${base}/flags/boot2.flag`]: new Uint8Array(), "config/example/config.ini": new TextEncoder().encode("config") };
  await f.save({ botbase: { ...f.app, files: Object.fromEntries(Object.keys(files).map(path => [path, path])) } });
  const fetcher = async (url: string) => url.startsWith("https://api.github.com/")
    ? Response.json({ tag_name: "v1", assets: [{ name: "app.zip" }] }) : new Response(zipSync(files));
  await run("install", f.options, fetcher);
  for (const [path, bytes] of Object.entries(files)) expect(new Uint8Array(await readFile(join(f.target, path)))).toEqual(bytes);
});

test("reserved metadata, traversal and sysmodule symlinks are rejected", async () => {
  const f = await fixture();
  for (const destination of ["switch", "switch/.switchpack", "switch/.SWITCHPACK/backups/x", ".switchpack-running", "config/.SWITCHPACK-RUNNING/file", "atmosphere/../outside", "atmosphere//file"]) {
    await f.save({ app: { ...f.app, destination } });
    await expect(run("install", f.options, f.fetcher)).rejects.toThrow();
  }
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await symlink(outside, join(f.target, "atmosphere"));
  await f.save({ app: { ...f.app, destination: "atmosphere/module.nsp" } });
  await expect(run("install", f.options, f.fetcher)).rejects.toThrow("symlink");
  expect(await readdir(outside)).toEqual([]);
});

test("sysmodule lockfile failure restores the previous module and removes its new boot flag", async () => {
  const f = await fixture(true);
  const base = "atmosphere/contents/430000000000000B";
  await mkdir(join(f.target, base), { recursive: true });
  await writeFile(join(f.target, base, "exefs.nsp"), "original module");
  await f.save({ botbase: { ...f.app, files: { "module": `${base}/exefs.nsp`, "flag": `${base}/flags/boot2.flag` } } });
  const fetcher = async (url: string) => {
    if (url.startsWith("https://api.github.com/")) return Response.json({ tag_name: "v1", assets: [{ name: "app.zip" }] });
    await mkdir(f.lock);
    return new Response(zipSync({ module: new TextEncoder().encode("new module"), flag: new Uint8Array() }));
  };
  await expect(run("install", f.options, fetcher)).rejects.toThrow();
  expect(await readFile(join(f.target, base, "exefs.nsp"), "utf8")).toBe("original module");
  expect(await Bun.file(join(f.target, base, "flags/boot2.flag")).exists()).toBe(false);
});

test("7z packages extract only mapped files, including empty files, and reject missing entries", async () => {
  const executable = Bun.which("7zz") ?? Bun.which("7z");
  if (!executable) throw new Error("Install 7zz/7z to run the 7z integration test");
  const f = await fixture();
  const source = join(f.root, "source");
  await mkdir(source);
  await writeFile(join(source, "module.nsp"), "module");
  await writeFile(join(source, "boot2.flag"), "");
  await writeFile(join(source, "unlisted"), "leave out");
  const archive = join(f.root, "package.7z");
  const child = Bun.spawn([executable, "a", archive, "."], { cwd: source, stdout: "ignore", stderr: "inherit" });
  expect(await child.exited).toBe(0);
  const base = "atmosphere/contents/430000000000000B";
  const app = { ...f.app, asset: "package.7z", destination: undefined, files: { "module.nsp": `${base}/exefs.nsp`, "boot2.flag": `${base}/flags/boot2.flag` } };
  await f.save({ botbase: app });
  const fetcher = async (url: string) => url.startsWith("https://api.github.com/")
    ? Response.json({ tag_name: "v1", assets: [{ name: "package.7z" }] }) : new Response(await readFile(archive));
  await run("install", f.options, fetcher);
  expect(await readFile(join(f.target, base, "exefs.nsp"), "utf8")).toBe("module");
  expect((await readFile(join(f.target, base, "flags/boot2.flag"))).length).toBe(0);
  expect(await run("status", f.options, fetcher)).toEqual(["botbase@v1: ok"]);
  expect((await readdir(f.target)).sort()).toEqual(["atmosphere", "switch"]);
  expect(await Bun.file(join(f.target, "unlisted")).exists()).toBe(false);
  await f.save({ botbase: { ...app, files: { missing: "elsewhere/file" } } });
  await expect(run("update", f.options, fetcher)).rejects.toThrow("missing or duplicated");
});

test("manifest enable state toggles offline with backups and status drift detection", async () => {
  const f = await fixture();
  const enableFile = "atmosphere/contents/430000000000000B/flags/boot2.flag";
  const app = { ...f.app, enableFile, enabled: true };
  await f.save({ app });
  await run("install", f.options, f.fetcher);
  expect((await readFile(join(f.target, enableFile))).length).toBe(0);
  app.enabled = false;
  await f.save({ app });
  const offline = async (): Promise<Response> => { throw new Error("Must work offline"); };
  const lockBefore = await readFile(f.lock, "utf8");
  expect((await run("install", { ...f.options, dryRun: true }, offline)).join(" ")).toContain("remove");
  expect(await Bun.file(join(f.target, enableFile)).exists()).toBe(true);
  expect(await readFile(f.lock, "utf8")).toBe(lockBefore);
  await run("install", f.options, offline);
  expect(await Bun.file(join(f.target, enableFile)).exists()).toBe(false);
  expect(await readFile(f.file, "utf8")).toBe("first release");
  expect(await run("status", f.options, offline)).toEqual(["app@v1: ok"]);
  const backups = join(f.target, "switch/.switchpack/backups");
  const [backup] = await readdir(backups);
  expect((await readFile(join(backups, backup!, enableFile))).length).toBe(0);
  await writeFile(join(f.target, enableFile), "");
  expect((await run("status", f.options, offline)).join(" ")).toContain("expected disabled");
  await run("install", f.options, offline);
  expect(await Bun.file(join(f.target, enableFile)).exists()).toBe(false);
  app.enabled = true;
  await f.save({ app });
  await run("install", f.options, offline);
  expect((await readFile(join(f.target, enableFile))).length).toBe(0);
  expect(await run("status", f.options, offline)).toEqual(["app@v1: ok"]);
});

test("enable-file removal rolls back when saving the lock fails", async () => {
  const f = await fixture();
  const enableFile = "config/example/enabled.flag";
  const app = { ...f.app, enableFile, enabled: true };
  await f.save({ app });
  await run("install", f.options, f.fetcher);
  app.enabled = false;
  await f.save({ app });
  const { filesystemTarget } = await import("../src/target");
  const target = await filesystemTarget(f.target);
  const originalRemove = target.remove;
  target.remove = async path => {
    await originalRemove(path);
    await rm(f.lock);
    await mkdir(f.lock);
  };
  await expect(run("install", f.options, f.fetcher, target)).rejects.toThrow();
  expect((await readFile(join(f.target, enableFile))).length).toBe(0);
});

test("enable settings require a boolean and a safe, non-conflicting file", async () => {
  const f = await fixture();
  for (const settings of [{ enabled: false }, { enableFile: "config/flag" }, { enableFile: "../flag", enabled: true }, { enableFile: f.app.destination, enabled: false }, { enableFile: "config/flag", enabled: "false" }]) {
    await f.save({ app: { ...f.app, ...settings } });
    await expect(run("install", f.options, f.fetcher)).rejects.toThrow();
  }
  expect(f.calls).toHaveLength(0);
});

test("disabled packages still update their payload to newer releases", async () => {
  const f = await fixture();
  await f.save({ app: { ...f.app, enableFile: "config/enabled.flag", enabled: false } });
  await run("install", f.options, f.fetcher);
  f.bump();
  await run("update", f.options, f.fetcher);
  expect(await readFile(f.file, "utf8")).toBe("second release");
  expect(JSON.parse(await readFile(f.lock, "utf8")).apps.app.tag).toBe("v2");
  expect(await Bun.file(join(f.target, "config/enabled.flag")).exists()).toBe(false);
});

test("a locked disabled package installs its payload on a fresh target", async () => {
  const f = await fixture();
  await f.save({ app: { ...f.app, enableFile: "config/enabled.flag", enabled: false } });
  await run("install", f.options, f.fetcher);
  const target = join(f.root, "fresh-sd");
  await mkdir(target);
  await run("install", { ...f.options, target }, f.fetcher);
  expect(await readFile(join(target, "switch/app/app.nro"), "utf8")).toBe("first release");
});

test("flag changes repair modified payloads from the locked release", async () => {
  const f = await fixture();
  const app = { ...f.app, enableFile: "config/enabled.flag", enabled: false };
  await f.save({ app });
  await run("install", f.options, f.fetcher);
  await writeFile(f.file, "modified payload");
  app.enabled = true;
  await f.save({ app });
  f.calls.length = 0;
  await run("install", f.options, f.fetcher);
  expect(await readFile(f.file, "utf8")).toBe("first release");
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toContain("/download/v1/");
  expect(await run("status", f.options, f.fetcher)).toEqual(["app@v1: ok"]);
});

test("a fresh PC discovers the Switch manifest and lock without creating local files", async () => {
  const f = await fixture();
  await run("install", f.options, f.fetcher);
  expect(JSON.parse(await readFile(join(f.target, SWITCH_MANIFEST), "utf8")).apps.app.repo).toBe("example/app");
  expect(await readFile(join(f.target, SWITCH_LOCK), "utf8")).toBe(await readFile(f.lock, "utf8"));
  await rm(f.manifest);
  await rm(f.lock);
  const options = { target: f.target };
  const offline = async (): Promise<Response> => { throw new Error("No network"); };
  expect(await run("status", options, offline)).toEqual(["app@v1: ok"]);
  const [exported] = await run("manifest", options, offline);
  expect(JSON.parse(exported!).apps.app.repo).toBe("example/app");
  f.calls.length = 0;
  await run("install", options, f.fetcher);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toContain("/download/v1/");
  f.bump();
  await run("update", options, f.fetcher);
  expect(await readFile(f.file, "utf8")).toBe("second release");
  expect(JSON.parse(await readFile(join(f.target, SWITCH_LOCK), "utf8")).apps.app.tag).toBe("v2");
  expect(await Bun.file(f.manifest).exists()).toBe(false);
  expect(await Bun.file(f.lock).exists()).toBe(false);
});

test("CLI bootstraps from the local manifest then prioritizes the saved Switch setup", async () => {
  const f = await fixture();
  const cli = join(import.meta.dir, "../src/cli.ts");
  const initial = Bun.spawnSync([process.execPath, cli, "manifest", "--target", f.target], { cwd: f.root });
  expect(initial.exitCode).toBe(0);
  expect(JSON.parse(initial.stdout.toString()).apps.app.repo).toBe("example/app");
  expect(await readdir(f.target)).toEqual([]);
  await run("install", f.options, f.fetcher);
  await writeFile(f.manifest, "invalid local JSON that must not be read");
  const result = Bun.spawnSync([process.execPath, cli, "status", "--target", f.target], { cwd: f.root });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("app@v1: ok");
  const fresh = join(f.root, "fresh-pc");
  await mkdir(fresh);
  const exported = Bun.spawnSync([process.execPath, cli, "manifest", "--target", f.target], { cwd: fresh });
  expect(exported.exitCode).toBe(0);
  expect(JSON.parse(exported.stdout.toString()).apps.app.repo).toBe("example/app");
  expect(await readdir(fresh)).toEqual([]);
});

test("edits to the on-Switch manifest can toggle boot flags offline", async () => {
  const f = await fixture();
  const enableFile = "config/app/enabled.flag";
  await f.save({ app: { ...f.app, enableFile, enabled: true } });
  await run("install", f.options, f.fetcher);
  const manifest = join(f.target, SWITCH_MANIFEST);
  const edited = JSON.parse(await readFile(manifest, "utf8"));
  edited.apps.app.enabled = false;
  await writeFile(manifest, JSON.stringify(edited));
  await run("install", { target: f.target }, async () => { throw new Error("Must work offline"); });
  expect(await Bun.file(join(f.target, enableFile)).exists()).toBe(false);
  expect(JSON.parse(await readFile(join(f.target, SWITCH_LOCK), "utf8")).apps.app.spec.enabled).toBe(false);
});

test("metadata write failure restores both app payloads and the saved setup", async () => {
  const f = await fixture();
  await run("install", f.options, f.fetcher);
  const manifestBefore = await readFile(join(f.target, SWITCH_MANIFEST), "utf8");
  const lockBefore = await readFile(join(f.target, SWITCH_LOCK), "utf8");
  const localBefore = await readFile(f.lock, "utf8");
  f.bump();
  // A changed manifest ensures rollback also restores its previous contents.
  f.app.version = "v2";
  await f.save();
  const { filesystemTarget } = await import("../src/target");
  const target = await filesystemTarget(f.target);
  const write = target.write;
  let failOnce = true;
  target.write = async (path, bytes, exclusive) => {
    await write(path, bytes, exclusive);
    if (path === SWITCH_LOCK && failOnce) { failOnce = false; throw new Error("USB write interrupted"); }
  };
  await expect(run("update", f.options, f.fetcher, target)).rejects.toThrow("USB write interrupted");
  expect(await readFile(f.file, "utf8")).toBe("first release");
  expect(await readFile(join(f.target, SWITCH_MANIFEST), "utf8")).toBe(manifestBefore);
  expect(await readFile(join(f.target, SWITCH_LOCK), "utf8")).toBe(lockBefore);
  expect(await readFile(f.lock, "utf8")).toBe(localBefore);
});

test("dry runs preserve saved metadata and explicit replacement reports unmanaged packages", async () => {
  const f = await fixture();
  await run("install", f.options, f.fetcher);
  const manifestBefore = await readFile(join(f.target, SWITCH_MANIFEST), "utf8");
  const lockBefore = await readFile(join(f.target, SWITCH_LOCK), "utf8");
  await f.save({});
  const messages = await run("update", { ...f.options, dryRun: true }, f.fetcher);
  expect(messages.join(" ")).toContain("stops managing: app");
  expect(await readFile(join(f.target, SWITCH_MANIFEST), "utf8")).toBe(manifestBefore);
  expect(await readFile(join(f.target, SWITCH_LOCK), "utf8")).toBe(lockBefore);
  await run("update", f.options, f.fetcher);
  expect(JSON.parse(await readFile(join(f.target, SWITCH_MANIFEST), "utf8")).apps).toEqual({});
  expect(await readFile(f.file, "utf8")).toBe("first release");
});

test("a missing explicit local lock reuses the saved lock", async () => {
  const f = await fixture();
  await run("install", f.options, f.fetcher);
  await rm(f.lock);
  f.calls.length = 0;
  await run("install", f.options, f.fetcher);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toContain("/download/v1/");
});

test("malformed saved manifests and reserved metadata destinations are rejected", async () => {
  const f = await fixture();
  await run("install", f.options, f.fetcher);
  await writeFile(join(f.target, SWITCH_MANIFEST), "not JSON");
  await expect(run("install", { target: f.target }, f.fetcher)).rejects.toThrow();
  for (const destination of [SWITCH_MANIFEST, SWITCH_LOCK, "switch/.switchpack"]) {
    await f.save({ app: { ...f.app, destination } });
    await expect(run("install", f.options, f.fetcher)).rejects.toThrow("backup storage");
  }
});

test("a malformed saved lock fails before modifying payloads", async () => {
  const f = await fixture();
  await run("install", f.options, f.fetcher);
  await writeFile(join(f.target, SWITCH_LOCK), "invalid lock");
  f.calls.length = 0;
  await expect(run("update", { target: f.target }, f.fetcher)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  expect(await readFile(f.file, "utf8")).toBe("first release");
});

test("declarative config overrides packaged defaults, updates offline, detects drift and survives releases", async () => {
  const f = await fixture(true);
  const path = "config/settings.ini";
  const app = { ...f.app, files: { ...f.app.files, "config/settings.ini": path }, configFiles: { [path]: "mode=usb\r\n", "config/empty.cfg": "" } as Record<string, string> };
  await f.save({ app });
  await run("install", f.options, f.fetcher);
  expect(await readFile(join(f.target, path), "utf8")).toBe("mode=usb\r\n");
  app.configFiles[path] = "mode=wifi\n";
  await f.save({ app });
  const offline = async (): Promise<Response> => { throw new Error("Must work offline"); };
  await run("install", { ...f.options, dryRun: true }, offline);
  expect(await readFile(join(f.target, path), "utf8")).toBe("mode=usb\r\n");
  await run("install", f.options, offline);
  expect(await readFile(join(f.target, path), "utf8")).toBe("mode=wifi\n");
  await writeFile(join(f.target, path), "manual edit");
  expect(await run("status", f.options, offline)).toEqual(["app@v1: modified"]);
  await run("install", f.options, offline);
  expect(await run("status", f.options, offline)).toEqual(["app@v1: ok"]);
  f.bump();
  await run("update", f.options, f.fetcher);
  expect(await readFile(join(f.target, path), "utf8")).toBe("mode=wifi\n");
  expect(await readFile(join(f.target, "config/empty.cfg"), "utf8")).toBe("");
  delete app.configFiles[path];
  await f.save({ app });
  await run("install", f.options, f.fetcher);
  expect(await readFile(join(f.target, path), "utf8")).toBe("do not copy");
});

test("managed configs reject unsafe paths, overlaps, non-string values and oversized content", async () => {
  const f = await fixture();
  for (const configFiles of [{ "../bad": "x" }, { "switch/.switchpack/config": "x" }, { "config/a": 1 }, { "config/a": "a".repeat(1024 * 1024 + 1) }, { "config/a": "x", "config/a/b": "y" }]) {
    await f.save({ app: { ...f.app, configFiles } });
    await expect(run("install", f.options, f.fetcher)).rejects.toThrow();
  }
  await f.save({ app: { ...f.app, configFiles: { "config/a": "x" }, enableFile: "config/a", enabled: false } });
  await expect(run("install", f.options, f.fetcher)).rejects.toThrow("Conflicting");
  await f.save({ app: { ...f.app, configFiles: { "config/a": "x" } }, other: { ...f.app, destination: "switch/other.nro", configFiles: { "CONFIG/a": "y" } } });
  await expect(run("install", f.options, f.fetcher)).rejects.toThrow("Conflicting");
  expect(f.calls).toHaveLength(0);
});

test("config changes roll back with the device manifest and lock on metadata failure", async () => {
  const f = await fixture();
  const app = { ...f.app, configFiles: { "config/app.ini": "old" } };
  await f.save({ app });
  await run("install", f.options, f.fetcher);
  const before = await readFile(join(f.target, SWITCH_MANIFEST));
  app.configFiles["config/app.ini"] = "new";
  await f.save({ app });
  const { filesystemTarget } = await import("../src/target");
  const target = await filesystemTarget(f.target);
  const originalWrite = target.write;
  let failed = false;
  target.write = async (path, ...args) => {
    if (path === SWITCH_LOCK && !failed) { failed = true; throw new Error("metadata interrupted"); }
    await originalWrite(path, ...args);
  };
  await expect(run("install", f.options, f.fetcher, target)).rejects.toThrow("metadata interrupted");
  expect(await readFile(join(f.target, "config/app.ini"), "utf8")).toBe("old");
  expect(await readFile(join(f.target, SWITCH_MANIFEST))).toEqual(before);
});

test("lockfile config hashes must agree with declared UTF-8 contents", async () => {
  const f = await fixture();
  await f.save({ app: { ...f.app, configFiles: { "config/app.ini": "wifi" } } });
  await run("install", f.options, f.fetcher);
  const lock = JSON.parse(await readFile(f.lock, "utf8"));
  lock.apps.app.files["config/app.ini"] = "0".repeat(64);
  await writeFile(f.lock, JSON.stringify(lock));
  await expect(run("status", f.options, f.fetcher)).rejects.toThrow("config checksum");
});
