import { afterEach, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { once } from "node:events";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { ftpTarget } from "../src/ftp";
import { run, SWITCH_LOCK } from "../src/manager";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

// A real loopback FTP peer exercises basic-ftp, passive data sockets and adapter framing.
async function fixture() {
  const files = new Map<string, Buffer>();
  const dirs = new Set(["/"]);
  const sockets = new Set<Socket>();
  const listeners = new Set<Server>();
  const commands: string[] = [];
  let corrupt = false, deny = false, reboot = true, failRename = false;
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    socket.write("220 test FTP\r\n");
    let buffer = "", cwd = "/", from = "";
    let data: Promise<Socket>;
    const path = (arg: string) => posix.resolve(cwd, arg);
    async function command(line: string) {
      commands.push(line);
      const [verb, ...args] = line.split(" "); const arg = args.join(" ");
      const reply = (text: string) => socket.write(text + "\r\n");
      if (verb === "USER") reply("331 password");
      else if (verb === "PASS") reply("230 logged in");
      else if (verb === "FEAT") reply("211-Features\r\n MLST type*;size*;modify*;\r\n EPSV\r\n211 End");
      else if (["TYPE", "STRU", "OPTS"].includes(verb!)) reply("200 ok");
      else if (verb === "PWD") reply(`257 "${cwd}"`);
      else if (verb === "CWD") { if (dirs.has(path(arg))) { cwd = path(arg); reply("250 cwd"); } else reply("550 missing directory"); }
      else if (verb === "MKD") { dirs.add(path(arg)); reply("257 created"); }
      else if (verb === "EPSV") {
        const passive = createServer(); listeners.add(passive);
        data = once(passive, "connection").then(([peer]) => {
          sockets.add(peer); peer.on("error", () => {}); peer.on("close", () => sockets.delete(peer)); passive.close(); listeners.delete(passive); return peer as Socket;
        });
        passive.listen(0, "127.0.0.1"); await once(passive, "listening");
        reply(`229 Entering Extended Passive Mode (|||${(passive.address() as { port: number }).port}|)`);
      } else if (verb === "MLSD" || verb === "LIST") {
        const folder = path(arg || ".");
        if (deny) { reply("550 permission denied"); return; }
        if (!dirs.has(folder)) { reply("550 missing directory"); return; }
        reply("150 listing"); const peer = await data!;
        const listing: string[] = [];
        for (const dir of dirs) if (dir !== "/" && posix.dirname(dir) === folder) listing.push(`type=dir;size=0;modify=20260101000000; ${posix.basename(dir)}`);
        for (const [file, bytes] of files) if (posix.dirname(file) === folder) listing.push(`type=file;size=${bytes.length};modify=20260101000000; ${posix.basename(file)}`);
        peer.end(listing.join("\r\n") + (listing.length ? "\r\n" : "")); reply("226 done");
      } else if (verb === "STOR") {
        reply("150 upload"); const peer = await data!; const chunks: Buffer[] = [];
        peer.on("data", chunk => chunks.push(Buffer.from(chunk))); await once(peer, "end");
        files.set(path(arg), corrupt ? Buffer.from("corrupt") : Buffer.concat(chunks)); corrupt = false;
        peer.end(); reply("226 done");
      } else if (verb === "RETR") {
        const bytes = files.get(path(arg)); if (!bytes) { reply("550 missing"); return; }
        reply("150 download"); const peer = await data!; peer.end(bytes); reply("226 done");
      } else if (verb === "RNFR") { from = path(arg); reply("350 rename"); }
      else if (verb === "RNTO") {
        if (files.has(path(arg))) reply("553 File exists");
        else if (failRename && from.endsWith(".tmp")) { failRename = false; reply("550 injected rename failure"); }
        else { files.set(path(arg), files.get(from)!); files.delete(from); reply("250 renamed"); }
      }
      else if (verb === "DELE") { files.delete(path(arg)); reply("250 removed"); }
      else if (verb === "REBT") reply(reboot ? "200 reboot requested" : "502 unsupported");
      else if (verb === "QUIT") socket.end("221 bye\r\n");
      else reply("502 unsupported");
    }
    let tail = Promise.resolve();
    socket.on("data", bytes => {
      buffer += bytes.toString(); let end;
      while ((end = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, end).replace(/\r$/, ""); buffer = buffer.slice(end + 1); tail = tail.then(() => command(line)).catch(error => { socket.destroy(error); }); }
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `ftp://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const target = ftpTarget(url);
  const root = await mkdtemp(join(tmpdir(), "switchpack-ftp-test-")); target.guard = join(root, "guard");
  cleanups.push(async () => { await target.close!(); for (const peer of sockets) peer.destroy(); for (const listener of listeners) listener.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  return { files, dirs, commands, url, target, root, corrupt() { corrupt = true; }, deny() { deny = true; }, unsupportedReboot() { reboot = false; }, failRename() { failRename = true; } };
}

test("FTP stages writes with readback and replacement rollback, distinguishes absence, and rejects exclusive replacement", async () => {
  const f = await fixture();
  expect(await f.target.read("config/app.ini")).toBeUndefined();
  await f.target.write("config/app.ini", Buffer.from("wifi\n"));
  expect(Buffer.from((await f.target.read("config/app.ini"))!).toString()).toBe("wifi\n");
  await expect(f.target.write("config/app.ini", Buffer.from("bad"), true)).rejects.toThrow("exists");
  await f.target.write("config/app.ini", Buffer.from("updated"));
  expect(f.files.get("/config/app.ini")?.toString()).toBe("updated");
  f.failRename();
  await expect(f.target.write("config/app.ini", Buffer.from("failed"))).rejects.toThrow("rename failure");
  expect(f.files.get("/config/app.ini")?.toString()).toBe("updated");
  await f.target.write("config/app.ini", Buffer.from("wifi\n"));
  f.corrupt();
  await expect(f.target.write("config/app.ini", Buffer.from("new"))).rejects.toThrow("readback mismatch");
  expect(f.files.get("/config/app.ini")?.toString()).toBe("wifi\n");
  expect([...f.files.keys()].some(path => path.endsWith(".tmp"))).toBe(false);
  await f.target.remove("config/app.ini");
  expect(await f.target.read("config/app.ini")).toBeUndefined();
  f.deny();
  await expect(f.target.read("config/app.ini")).rejects.toThrow("permission denied");
});

test("FTP uses the same install/config/lock/status engine and supports explicit reboot", async () => {
  const f = await fixture();
  const manifest = join(f.root, "switchpack.json");
  const app = { repo: "example/app", version: "v1", asset: "app.nro", destination: "switch/app.nro", configFiles: { "config/app.ini": "wifi\n" } };
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, apps: { app } }));
  const fetcher = async (url: string) => url.includes("api.github.com") ? Response.json({ tag_name: "v1", assets: [{ name: "app.nro" }] }) : new Response("app binary");
  const options = { manifest, ftp: f.url };
  await run("install", options, fetcher, f.target);
  const statusTarget = ftpTarget(f.url); statusTarget.guard = f.target.guard;
  expect(await run("status", { ftp: f.url }, fetcher, statusTarget)).toEqual(["app@v1: ok"]);
  expect(JSON.parse((await readFile(join(f.root, "switchpack.lock.json"))).toString()).apps.app.files["config/app.ini"]).toHaveLength(64);
  expect(f.files.has("/" + SWITCH_LOCK)).toBe(true);
  const rebootTarget = ftpTarget(f.url); rebootTarget.guard = f.target.guard;
  expect((await run("reboot", { ftp: f.url }, fetcher, rebootTarget)).join()).toContain("acknowledged");
  f.unsupportedReboot();
  const unsupported = ftpTarget(f.url); unsupported.guard = f.target.guard;
  await expect(run("reboot", { ftp: f.url }, fetcher, unsupported)).rejects.toThrow("unsupported");
});

test("FTP rejects credentials in URLs and unsafe paths; mounted SD cannot reboot", async () => {
  expect(() => ftpTarget("ftp://user:secret@localhost/")).toThrow("credentials");
  const f = await fixture();
  await expect(f.target.read("../escape")).rejects.toThrow("Unsafe");
  await expect(run("reboot", { target: f.root })).rejects.toThrow("does not support reboot");
});
