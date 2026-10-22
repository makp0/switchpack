import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mtpTarget } from "../src/target";
import { run, SWITCH_MANIFEST, SWITCH_LOCK } from "../src/manager";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "switchpack-mtp-test-"));
  roots.push(root);
  const sd = join(root, "sd");
  await mkdir(sd);
  const helper = join(root, "helper");
  // Exercise the real subprocess adapter with the helper's exit-code contract.
  await writeFile(helper, `#!${process.execPath}
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const [action, remote, local] = process.argv.slice(2);
const root = ${JSON.stringify(root)};
const file = join(root, 'sd', remote);
if (await Bun.file(join(root, 'disconnect')).exists()) { console.error('USB disconnected'); process.exit(2); }
try {
  if (action === 'read') await copyFile(file, local);
  else if (action === 'delete') await rm(file);
  else {
    await mkdir(dirname(file), { recursive: true });
    if (action === 'create' && await Bun.file(file).exists()) { console.error('already exists'); process.exit(2); }
    let bytes = await readFile(local);
    if (remote === 'switch/app.nro' && await Bun.file(join(root, 'corrupt-once')).exists()) {
      bytes = Buffer.from('corrupted transfer'); await rm(join(root, 'corrupt-once'));
    }
    await writeFile(file, bytes);
  }
} catch (error) { if (error.code === 'ENOENT') process.exit(3); throw error; }
`);
  await chmod(helper, 0o755);
  const manifest = join(root, "switchpack.json");
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, apps: { app: { repo: "example/app", version: "latest", asset: "app.nro", destination: "switch/app.nro" } } }));
  const target = mtpTarget(helper);
  // Keep independent test fixtures from contending on the hardware guard.
  target.guard = join(root, "mtp-guard");
  const fetcher = async (url: string) => url.startsWith("https://api.github.com/")
    ? Response.json({ tag_name: "v1", assets: [{ name: "app.nro" }] }) : new Response("new app");
  return { root, sd, helper, manifest, target, fetcher, options: { manifest, mtp: true, mtpHelper: helper } };
}

test("MTP adapter distinguishes absent files from connection failures", async () => {
  const f = await fixture();
  expect(await f.target.read("switch/app.nro")).toBeUndefined();
  await writeFile(join(f.root, "disconnect"), "");
  await expect(f.target.read("switch/app.nro")).rejects.toThrow("USB disconnected");
});

test("MTP install, status, backup and exclusive creation use the helper", async () => {
  const f = await fixture();
  await mkdir(join(f.sd, "switch"));
  await writeFile(join(f.sd, "switch/app.nro"), "old app");
  await run("install", f.options, f.fetcher, f.target);
  expect(await readFile(join(f.sd, "switch/app.nro"), "utf8")).toBe("new app");
  expect(await run("status", f.options, f.fetcher, f.target)).toEqual(["app@v1: ok"]);
  const backups = join(f.sd, "switch/.switchpack/backups");
  const [backup] = await readdir(backups);
  expect(await readFile(join(backups, backup!, "switch/app.nro"), "utf8")).toBe("old app");
  await expect(f.target.write("switch/app.nro", new Uint8Array(), true)).rejects.toThrow("already exists");
});

test("corrupt MTP readback restores old content without committing a lockfile", async () => {
  const f = await fixture();
  await mkdir(join(f.sd, "switch"));
  await writeFile(join(f.sd, "switch/app.nro"), "old app");
  await writeFile(join(f.root, "corrupt-once"), "");
  await expect(run("install", f.options, f.fetcher, f.target)).rejects.toThrow("readback mismatch");
  expect(await readFile(join(f.sd, "switch/app.nro"), "utf8")).toBe("old app");
  expect(await Bun.file(join(f.root, "switchpack.lock.json")).exists()).toBe(false);
});

test("corrupt newly installed MTP file is removed during rollback", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "corrupt-once"), "");
  await expect(run("install", f.options, f.fetcher, f.target)).rejects.toThrow("readback mismatch");
  expect(await f.target.read("switch/app.nro")).toBeUndefined();
});

test("MTP dry run reads the console but does not write app files or lockfile", async () => {
  const f = await fixture();
  await run("install", { ...f.options, dryRun: true }, f.fetcher, f.target);
  expect(await readdir(f.sd)).toEqual([]);
  expect(await Bun.file(join(f.root, "switchpack.lock.json")).exists()).toBe(false);
});

test("CLI rejects both connection modes together", () => {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "install", "--mtp", "--target", "/tmp"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("cannot be used with");
});


test("MTP sysmodule packages use the same install, backup and status flow", async () => {
  const f = await fixture();
  const destination = "atmosphere/contents/430000000000000B/exefs.nsp";
  await mkdir(join(f.sd, "atmosphere/contents/430000000000000B"), { recursive: true });
  await writeFile(join(f.sd, destination), "old module");
  await writeFile(f.manifest, JSON.stringify({ schemaVersion: 1, apps: { botbase: { repo: "example/botbase", version: "latest", asset: "app.nro", destination } } }));
  await run("install", f.options, f.fetcher, f.target);
  expect(await readFile(join(f.sd, destination), "utf8")).toBe("new app");
  expect(await run("status", f.options, f.fetcher, f.target)).toEqual(["botbase@v1: ok"]);
  const backups = join(f.sd, "switch/.switchpack/backups");
  const [backup] = await readdir(backups);
  expect(await readFile(join(backups, backup!, destination), "utf8")).toBe("old module");
  await expect(f.target.read("atmosphere/../outside")).rejects.toThrow("Unsafe");
});

test("MTP manifest enable files can be removed, verified and recreated offline", async () => {
  const f = await fixture();
  const enableFile = "atmosphere/contents/430000000000000B/flags/boot2.flag";
  const app = { repo: "example/app", version: "latest", asset: "app.nro", destination: "switch/app.nro", enableFile, enabled: true };
  const save = () => writeFile(f.manifest, JSON.stringify({ schemaVersion: 1, apps: { app } }));
  await save();
  await run("install", f.options, f.fetcher, f.target);
  expect((await f.target.read(enableFile))?.length).toBe(0);
  app.enabled = false;
  await save();
  const offline = async (): Promise<Response> => { throw new Error("Must work offline"); };
  await run("install", f.options, offline, f.target);
  expect(await f.target.read(enableFile)).toBeUndefined();
  expect(await run("status", f.options, offline, f.target)).toEqual(["app@v1: ok"]);
  app.enabled = true;
  await save();
  await run("install", f.options, offline, f.target);
  expect((await f.target.read(enableFile))?.length).toBe(0);
});

test("fresh-PC MTP discovery reads saved manifest and lock through the helper", async () => {
  const f = await fixture();
  await run("install", f.options, f.fetcher, f.target);
  expect(await f.target.read(SWITCH_MANIFEST)).toBeDefined();
  expect(await f.target.read(SWITCH_LOCK)).toBeDefined();
  await rm(f.manifest);
  await rm(join(f.root, "switchpack.lock.json"));
  const options = { mtp: true, mtpHelper: f.helper };
  const offline = async (): Promise<Response> => { throw new Error("No network"); };
  expect(await run("status", options, offline, f.target)).toEqual(["app@v1: ok"]);
  const [manifest] = await run("manifest", options, offline, f.target);
  expect(JSON.parse(manifest!).apps.app.repo).toBe("example/app");
  await run("install", options, f.fetcher, f.target);
  expect(await Bun.file(f.manifest).exists()).toBe(false);
  expect(await Bun.file(join(f.root, "switchpack.lock.json")).exists()).toBe(false);
});
