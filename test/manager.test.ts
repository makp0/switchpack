import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { run } from "../src/manager";

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
  for (const destination of ["../outside", "/switch/app.nro", "switch/../save", "atmosphere/app", "switch/x\\y", "switch/x./file"]) {
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
  expect(missing.stderr.toString()).toContain("required option");
});
