#!/usr/bin/env bun
import { Command, Option } from "commander";
import { run, type Options } from "./manager";

const program = new Command()
  .name("switchpack")
  .description("Manage Switch homebrew and sysmodule packages from a JSON manifest and checksum lockfile")
  .version("0.1.0");

for (const command of ["install", "update", "status"] as const) {
  const sub = program.command(command)
    .description({ install: "Install locked releases; resolve apps without a lock entry", update: "Resolve manifest versions and install updates", status: "Compare target files against the lockfile (offline)" }[command])
    .option("-m, --manifest <path>", "package manifest", "switchpack.json")
    .addOption(new Option("-t, --target <directory>", "Hekate USB Mass Storage, mounted SD card root, or staging directory").conflicts("mtp"))
    .addOption(new Option("--mtp", "connect to DBI's MTP responder over USB").conflicts("target"))
    .addOption(new Option("--mtp-helper <path>", "native libmtp helper executable").implies({ mtp: true }))
    .addOption(new Option("--release-camera", "macOS: stop ptpcamerad before each USB connection").implies({ mtp: true }));
  if (command !== "status") sub.option("--dry-run", "resolve and verify downloads without writing files");
  sub.action(async (options: Options) => {
    for (const line of await run(command, options)) console.log(line);
  });
}

try { await program.parseAsync(); }
catch (error) { program.error(error instanceof Error ? error.message : String(error)); }
