#!/usr/bin/env node
/**
 * @founder-os/handoff-providers -- standalone CLI counterpart.
 *
 * Parallel to src-tauri/src/codesign.rs. Same envelope shapes so a
 * developer (or a CI smoke job) can probe / spawn without a Tauri
 * round trip:
 *
 *   pnpm --filter @founder-os/handoff-providers cli -- probe
 *   pnpm --filter @founder-os/handoff-providers cli -- spawn
 *
 * `--` is forwarded as a literal argv entry by pnpm 10 (see the
 * "pnpm `--` argv" memory) so we drop any literal "--" before parsing.
 *
 * Output is single-line JSON for easy consumption from shells or
 * other tools. Exit code is 0 on success, 1 on probe-failure /
 * spawn-failure, 2 on usage error.
 */

import { argv, exit, stdout } from "node:process";
import {
  createCodesignLauncher,
  probeCodesignBinary,
} from "./codesign-launcher.js";

type Command = "probe" | "spawn";

const USAGE = `Usage:
  handoff-providers probe [--binary <path>]
  handoff-providers spawn [--binary <path>]
`;

async function main(): Promise<void> {
  // pnpm 10 forwards "--" as a literal argv entry.
  const args = argv.slice(2).filter((a) => a !== "--");

  const cmd = args[0] as Command | undefined;
  if (!cmd || (cmd !== "probe" && cmd !== "spawn")) {
    stdout.write(USAGE);
    exit(2);
  }

  let binary: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--binary") {
      binary = args[++i];
    } else if (a?.startsWith("--binary=")) {
      binary = a.slice("--binary=".length);
    }
  }

  if (cmd === "probe") {
    const result = await probeCodesignBinary(binary);
    stdout.write(`${JSON.stringify(result)}\n`);
    exit(result.available ? 0 : 1);
  }

  // spawn
  const launcher = createCodesignLauncher({ binary });
  await launcher.probe();
  const result = await launcher.spawn();
  stdout.write(`${JSON.stringify(result)}\n`);
  exit(result.spawned ? 0 : 1);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  stdout.write(`${JSON.stringify({ error: message })}\n`);
  exit(1);
});
