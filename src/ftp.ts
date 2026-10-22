import { Client } from "basic-ftp";
import { Readable, Writable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { join, posix } from "node:path";
import { tmpdir } from "node:os";
import { relativePath } from "./paths";
import type { Target } from "./target";

const MAX_BYTES = 128 * 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function ftpTarget(address: string): Target {
  const url = new URL(address);
  if (!["ftp:", "ftps:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Expected ftp://host:port/SD-root (or ftps://); use SWITCHPACK_FTP_USER/PASSWORD for credentials");
  }
  const root = decodeURIComponent(url.pathname).replace(/\/$/, "");
  if (/[\x00-\x1f\\]/.test(root) || root.split("/").some(part => part === "." || part === "..")) throw new Error("Unsafe FTP root");
  const client = new Client(15000);
  let connected = false;
  const remote = (path: string) => { relativePath(path); return `${root}/${path}`; };
  async function connect() {
    if (connected) return;
    await client.access({ host: url.hostname, port: Number(url.port || 21), user: process.env.SWITCHPACK_FTP_USER ?? "anonymous", password: process.env.SWITCHPACK_FTP_PASSWORD ?? "guest", secure: url.protocol === "ftps:" });
    connected = true;
  }
  // Listing distinguishes absence from permissions/connection errors and rejects symlinks.
  async function lookup(path: string) {
    relativePath(path);
    await connect();
    const parts = path.split("/");
    let parent = root || "/";
    for (const [index, part] of parts.entries()) {
      const entry = (await client.list(parent)).find(file => file.name.toLowerCase() === part.toLowerCase());
      if (!entry) return undefined;
      if (entry.isSymbolicLink) throw new Error(`Refusing FTP symlink: ${path}`);
      if (index < parts.length - 1 && !entry.isDirectory) throw new Error(`Expected FTP directory: ${path}`);
      if (index === parts.length - 1) return entry;
      parent = posix.join(parent, entry.name);
    }
  }
  async function download(path: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = new Writable({ write(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_BYTES) return callback(new Error("FTP download exceeds 128 MiB limit"));
      chunks.push(Buffer.from(chunk)); callback();
    } });
    await client.downloadTo(stream, remote(path));
    return Buffer.concat(chunks, size);
  }
  return {
    // Share the existing MTP guard: USB and Wi-Fi must not mutate one console concurrently.
    guard: join(tmpdir(), "switchpack-mtp-running"),
    async read(path) {
      const entry = await lookup(path);
      if (!entry) return undefined;
      if (!entry.isFile || entry.size > MAX_BYTES) throw new Error(`Invalid FTP file: ${path}`);
      return download(path);
    },
    async write(path, data, exclusive = false) {
      const entry = await lookup(path);
      if (entry && (!entry.isFile || exclusive)) throw new Error(`FTP destination exists: ${path}`);
      if (data.length > MAX_BYTES) throw new Error("FTP upload exceeds 128 MiB limit");
      const temp = `${path}.${randomUUID()}.tmp`;
      await client.ensureDir(posix.dirname(remote(path)));
      try {
        await client.uploadFrom(Readable.from([Buffer.from(data)]), remote(temp));
        if (hash(await download(temp)) !== hash(data)) throw new Error(`FTP upload readback mismatch: ${path}`);
        if (exclusive && await lookup(path)) throw new Error(`FTP destination exists: ${path}`);
        if (entry) {
          // Sphaira refuses RNTO over an existing file. Preserve it until replacement succeeds.
          const previous = `${temp}.previous`;
          await client.rename(remote(path), remote(previous));
          try {
            await client.rename(remote(temp), remote(path));
          } catch (error) {
            try { await client.rename(remote(previous), remote(path)); }
            catch { throw new Error(`FTP replacement/restore failed; original retained at ${previous}`, { cause: error }); }
            throw error;
          }
          await client.remove(remote(previous));
        } else await client.rename(remote(temp), remote(path));
      } finally {
        if (!client.closed) await client.remove(remote(temp)).catch(() => {});
      }
    },
    async remove(path) {
      const entry = await lookup(path);
      if (entry) {
        if (!entry.isFile) throw new Error(`Invalid FTP file: ${path}`);
        await client.remove(remote(path));
      }
    },
    async reboot() {
      await connect();
      // ftpsrv's explicit REBT extension; unsupported servers return an error.
      const result = await client.send("REBT");
      if (result.code !== 200) throw new Error(`FTP server did not acknowledge reboot (${result.code})`);
    },
    async close() { client.close(); },
    describe(path) { return `${url.protocol}//${url.host}${remote(path)}`; },
  };
}
