// HyperFrames project lifecycle helpers.
//
// A HyperFrames "project" is a directory containing index.html + a
// hyperframes.json config + compositions/ + assets/. There is no build
// step. The provider needs the project to exist before it can render;
// this module verifies and (optionally) bootstraps one.
//
// Bootstrapping is split into a separate exported function from the
// provider's render() so the stage runner (slice 3) can decide WHEN to
// install the curated preset of blocks/components -- typically once at
// stage entry, not on every render.

import { stat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runHyperframes } from "./spawn.js";

export interface ProjectPaths {
  root: string;
  indexHtml: string;
  configJson: string;
  compositionsDir: string;
  assetsDir: string;
}

export function projectPaths(root: string): ProjectPaths {
  return {
    root,
    indexHtml: join(root, "index.html"),
    configJson: join(root, "hyperframes.json"),
    compositionsDir: join(root, "compositions"),
    assetsDir: join(root, "assets"),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Throw if the directory does not look like a HyperFrames project.
 * Used by the provider before render to surface a clean error
 * ("project not bootstrapped") instead of a noisy CLI error.
 */
export async function assertHyperframesProject(root: string): Promise<void> {
  const p = projectPaths(root);
  if (!(await exists(p.indexHtml))) {
    throw new Error(
      `not a HyperFrames project (no index.html at ${p.indexHtml}). ` +
        `Run bootstrapHyperframesProject() once before rendering.`,
    );
  }
}

export interface BootstrapOpts {
  /** Project directory to scaffold into. Created if it does not exist. */
  root: string;
  /** Example template. Default "blank" (Founder OS supplies its own brand). */
  example?: string;
  /** Pass --tailwind to init. Default true (we use the v4 browser runtime). */
  tailwind?: boolean;
  /** Pass --skip-skills to init. Default true (we manage skills ourselves). */
  skipSkills?: boolean;
  /** Per-CLI-call timeout. Default 120s. */
  timeoutMs?: number;
}

/**
 * Run `hyperframes init` to scaffold a fresh project. Pure subprocess
 * call -- caller is responsible for installing preset blocks/components
 * afterwards (see addBlocks / addComponents helpers below).
 */
export async function bootstrapHyperframesProject(
  opts: BootstrapOpts,
): Promise<ProjectPaths> {
  const example = opts.example ?? "blank";
  const tailwind = opts.tailwind ?? true;
  const skipSkills = opts.skipSkills ?? true;

  await mkdir(opts.root, { recursive: true });

  const args: string[] = [
    "init",
    opts.root,
    "--example",
    example,
  ];
  if (tailwind) args.push("--tailwind");
  if (skipSkills) args.push("--skip-skills");

  const result = await runHyperframes(args, { timeoutMs: opts.timeoutMs });
  if (result.code !== 0) {
    throw new Error(
      `hyperframes init failed (exit ${result.code}): ${result.stderr.slice(0, 240).trim()}`,
    );
  }

  return projectPaths(opts.root);
}

/**
 * Install one or more catalog items (blocks, components, examples)
 * into an existing project via `hyperframes add`. Uses --no-clipboard
 * --json for non-interactive output. Returns nothing -- failures throw.
 */
export async function addCatalogItems(
  root: string,
  names: ReadonlyArray<string>,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  for (const name of names) {
    const result = await runHyperframes(
      ["add", name, "--dir", root, "--no-clipboard", "--json"],
      { timeoutMs: opts.timeoutMs },
    );
    if (result.code !== 0) {
      throw new Error(
        `hyperframes add ${name} failed (exit ${result.code}): ` +
          `${result.stderr.slice(0, 240).trim()}`,
      );
    }
  }
}

/**
 * Write a per-shot variables JSON file under <root>/.hf-runs/. Returns
 * the absolute path. Using --variables-file <path> instead of
 * --variables '<json>' avoids Node's BatBadBut mitigation refusing to
 * spawn .cmd shims with quoted JSON args.
 */
export async function writeVariablesFile(
  root: string,
  shotId: string,
  variables: Record<string, unknown>,
): Promise<string> {
  const dir = join(root, ".hf-runs");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${shotId}-variables.json`);
  await writeFile(path, JSON.stringify(variables, null, 2), "utf8");
  return path;
}
