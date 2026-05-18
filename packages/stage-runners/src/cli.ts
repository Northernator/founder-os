#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { VentureManifestSchema, type StageRunResult } from "@founder-os/domain";
import { nodeFs, type Filesystem } from "@founder-os/pipeline-runner";
import { HandoffPackStageRunner } from "./node.js";

type ErrorEnvelope = { error: string };

type RunStageEnvelope = {
  result: Awaited<ReturnType<HandoffPackStageRunner["run"]>>;
  counts: {
    docsRendered: number;
    rolePacksGenerated: number;
    failed: number;
  };
  steps: {
    brand: "ok" | "missing";
    docs: "ok" | "missing";
    rolePacks: "ok" | "missing";
    inventory: "ok" | "missing";
  };
  checkpointPath?: string;
};

type CliDeps = {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  fs: Filesystem;
  Runner: typeof HandoffPackStageRunner;
};

const defaultDeps: CliDeps = {
  existsSync,
  readFileSync,
  fs: nodeFs,
  Runner: HandoffPackStageRunner,
};

export async function runStageRunnersCli(
  argv: string[],
  deps: CliDeps = defaultDeps,
): Promise<{ exitCode: number; envelope: RunStageEnvelope | ErrorEnvelope }> {
  const [, , cmd, ...args] = argv;
  try {
  if (cmd === "handoff-pack-run-stage") {
      return { exitCode: 0, envelope: await runHandoffPackStage(args, deps) };
  } else {
      return { exitCode: 1, envelope: usageEnvelope() };
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, envelope: { error: message } };
  }
}

async function main(): Promise<void> {
  const { exitCode, envelope } = await runStageRunnersCli(process.argv);
  emit(envelope);
  process.exitCode = exitCode;
}

async function runHandoffPackStage(args: string[], deps: CliDeps): Promise<RunStageEnvelope> {
  const ventureRoot = flag(args, "--venture-root");
  const manifestPath = flag(args, "--manifest");
  if (!ventureRoot) throw new Error("--venture-root is required");
  if (!manifestPath) throw new Error("--manifest is required");
  if (!deps.existsSync(ventureRoot)) throw new Error(`venture root does not exist: ${ventureRoot}`);
  if (!deps.existsSync(manifestPath)) throw new Error(`manifest does not exist: ${manifestPath}`);

  const manifest = VentureManifestSchema.parse(parseJsonFile(deps.readFileSync(manifestPath, "utf8")));
  const runner = new deps.Runner({
    ventureRoot,
    manifest,
    fs: deps.fs,
  });
  const result = await runner.run();
  const checkpointPath = `${ventureRoot}/13_handoff_pack/handoff-pack-checkpoint.json`;
  const summary = summarizeRun(result, checkpointPath, deps);
  return {
    result,
    counts: summary.counts,
    steps: summary.steps,
    checkpointPath,
  };
}

function summarizeRun(
  result: StageRunResult,
  checkpointPath: string,
  deps: CliDeps,
): Pick<RunStageEnvelope, "counts" | "steps"> {
  try {
    if (deps.existsSync(checkpointPath)) {
      const checkpoint = parseJsonFile(deps.readFileSync(checkpointPath, "utf8")) as {
        docsRendered?: number;
        docsPartial?: number;
        docsStubbed?: number;
        docsFailed?: number;
        rolePacksGenerated?: number;
        inventoryPath?: string;
      };
      const docsRendered =
        (checkpoint.docsRendered ?? 0) +
        (checkpoint.docsPartial ?? 0) +
        (checkpoint.docsStubbed ?? 0);
      return {
        counts: {
          docsRendered,
          rolePacksGenerated: checkpoint.rolePacksGenerated ?? 0,
          failed: checkpoint.docsFailed ?? 0,
        },
        steps: {
          brand: result.success ? "ok" : "missing",
          docs: docsRendered > 0 ? "ok" : "missing",
          rolePacks: (checkpoint.rolePacksGenerated ?? 0) > 0 ? "ok" : "missing",
          inventory: checkpoint.inventoryPath ? "ok" : "missing",
        },
      };
    }
  } catch {
    // Fall back to artifact-path heuristics if checkpoint read/parsing fails.
  }
  return {
    counts: countArtifacts(result.artifactsCreated),
    steps: deriveSteps(result.artifactsCreated, result.success),
  };
}

function countArtifacts(paths: ReadonlyArray<string>): RunStageEnvelope["counts"] {
  const pdfs = paths.filter((path) => path.endsWith(".pdf"));
  const rolePacks = pdfs.filter((path) => path.includes("/role-packs/") || path.includes("\\role-packs\\"));
  return {
    docsRendered: pdfs.length - rolePacks.length,
    rolePacksGenerated: rolePacks.length,
    failed: 0,
  };
}

function deriveSteps(paths: ReadonlyArray<string>, success: boolean): RunStageEnvelope["steps"] {
  const has = (needle: string) => paths.some((path) => path.includes(needle));
  const hasPdf = paths.some((path) => path.endsWith(".pdf") && !path.includes("/role-packs/") && !path.includes("\\role-packs\\"));
  return {
    brand: success || has("/.brand/") || has("\\.brand\\") ? "ok" : "missing",
    docs: hasPdf ? "ok" : "missing",
    rolePacks: has("/role-packs/") || has("\\role-packs\\") ? "ok" : "missing",
    inventory: has("INDEX.md") || has("handoff-pack-inventory.json") ? "ok" : "missing",
  };
}

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function parseJsonFile(raw: string): unknown {
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

function emit<T>(value: T): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function usageEnvelope(): ErrorEnvelope {
  return {
    error: "usage: stage-runners handoff-pack-run-stage --venture-root <abs> --manifest <abs>",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
