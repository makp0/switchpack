import { relativePath } from "./paths";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

export type Target = {
  guard: string;
  read(path: string): Promise<Uint8Array | undefined>;
  write(path: string, data: Uint8Array, exclusive?: boolean): Promise<void>;
  remove(path: string): Promise<void>;
  describe(path: string): string;
};

export async function optionalRead(path: string): Promise<Uint8Array | undefined> {
  try { return await readFile(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// Check every existing component, including the destination itself.
async function safePath(root: string, path: string): Promise<string> {
  relativePath(path);
  let current = root;
  const parts = path.split("/");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Refusing symlink: ${current}`);
      if (index < parts.length - 1 ? !info.isDirectory() : !info.isFile()) throw new Error(`Unexpected file type: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return current;
}

export async function filesystemTarget(directory: string): Promise<Target> {
  const root = await realpath(directory);
  if (!(await lstat(root)).isDirectory()) throw new Error("Target must be an existing directory");
  return {
    guard: join(root, ".switchpack-running"),
    async read(path) { return optionalRead(await safePath(root, path)); },
    async write(path, data, exclusive = false) {
      const local = await safePath(root, path);
      await mkdir(dirname(local), { recursive: true });
      await writeFile(local, data, { flag: exclusive ? "wx" : "w" });
    },
    async remove(path) { await rm(await safePath(root, path), { force: true }); },
    describe(path) { return join(root, path); },
  };
}

export function mtpTarget(helper?: string, releaseCamera = false): Target {
  if (releaseCamera && process.platform !== "darwin") throw new Error("--release-camera is only supported on macOS");
  const executable = resolve(helper ?? (import.meta.path.includes("$bunfs")
    ? join(dirname(process.execPath), "switchpack-mtp")
    : join(import.meta.dir, "../dist/switchpack-mtp")));
  if (!existsSync(executable)) throw new Error(`MTP helper missing: ${executable}. Run bun run build:mtp (requires libmtp and a C compiler), or pass --mtp-helper.`);
  async function invoke(args: string[]): Promise<number> {
    relativePath(args[1]);
    if (releaseCamera) {
      // Image Capture can reclaim USB between helper processes. Release it just before opening MTP.
      const camera = Bun.spawn(["pkill", "-KILL", "-x", "ptpcamerad"], { stdout: "ignore", stderr: "pipe" });
      const [error, code] = await Promise.all([new Response(camera.stderr).text(), camera.exited]);
      if (code > 1) throw new Error(`Cannot release macOS camera service: ${error.trim()}`);
    }
    const child = Bun.spawn([executable, ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    // Exit 3 means a remote file is absent; connection failures must never look like absence.
    if (code !== 0 && code !== 3) throw new Error(`MTP ${args[0]} failed (exit ${code}${child.signalCode ? `, ${child.signalCode}` : ""}): ${(err || out).trim()}\nKeep DBI's MTP responder open and close other MTP clients. On macOS, try --release-camera to stop ptpcamerad before each connection.`);
    return code;
  }
  return {
    guard: join(tmpdir(), "switchpack-mtp-running"),
    async read(path) {
      const temp = await mkdtemp(join(tmpdir(), "switchpack-mtp-"));
      try {
        const file = join(temp, "readback");
        return await invoke(["read", path, file]) === 3 ? undefined : await readFile(file);
      } finally { await rm(temp, { recursive: true, force: true }); }
    },
    async write(path, data, exclusive = false) {
      const temp = await mkdtemp(join(tmpdir(), "switchpack-mtp-"));
      try {
        const file = join(temp, "upload");
        await writeFile(file, data);
        if (await invoke([exclusive ? "create" : "write", path, file]) !== 0) throw new Error(`MTP write failed: ${path}`);
      } finally { await rm(temp, { recursive: true, force: true }); }
    },
    async remove(path) { await invoke(["delete", path]); },
    describe(path) { return `DBI SD Card:/${path}`; },
  };
}
