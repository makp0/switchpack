import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const flags: string[] = [];
if (process.platform === "darwin") {
  const brew = Bun.spawnSync(["brew", "--prefix", "libmtp"]);
  if (brew.exitCode !== 0) throw new Error("Install libmtp with: brew install libmtp");
  const prefix = brew.stdout.toString().trim();
  flags.push(`-I${prefix}/include`, `-L${prefix}/lib`, "-lmtp");
} else {
  const pkg = Bun.spawnSync(["pkg-config", "--cflags", "--libs", "libmtp"]);
  if (pkg.exitCode !== 0) throw new Error("Install libmtp development headers and pkg-config");
  flags.push(...pkg.stdout.toString().trim().split(/\s+/));
}
await mkdir(join(root, "dist"), { recursive: true });
const child = Bun.spawn(["cc", "-std=c11", "-D_DEFAULT_SOURCE", "-Wall", "-Wextra", "-Werror", "-O2", join(root, "native/mtp-transfer.c"), ...flags, "-o", join(root, "dist/switchpack-mtp")], { stdout: "inherit", stderr: "inherit" });
if (await child.exited !== 0) process.exit(1);
console.log("Built dist/switchpack-mtp");
