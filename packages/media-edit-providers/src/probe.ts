// Probe helpers for the OpenCut self-hosted provider.
//
// Two probes:
//   1. probeBunRuntime() -- does `bun --version` work? capture the version
//      and resolved path (best-effort).
//   2. validateOpencutVendor(vendorPath) -- does the path contain something
//      that looks like an OpenCut clone? Read package.json, sniff name.
//
// Both are pure Node (node:fs + spawn), so they live behind the /node
// subpath and never run in the WebView.

import { promises as fs } from "node:fs";
import path from "node:path";
import { BunNotFoundError, runBun } from "./spawn.js";

export interface BunRuntimeProbe {
  available: boolean;
  /** Resolved path to the binary, when available. Best-effort. */
  path?: string;
  /** Version string parsed from `bun --version`, when available. */
  version?: string;
  /** Reason rendered in the UI when available=false. */
  reason?: string;
}

/**
 * Resolve whether `bun` is on PATH. Calls `bun --version` and parses the
 * output. Returns available=false with a reason when the binary is
 * missing or the version probe fails.
 */
export async function probeBunRuntime(): Promise<BunRuntimeProbe> {
  try {
    const result = await runBun(["--version"], { timeoutMs: 5_000 });
    if (result.code !== 0) {
      return {
        available: false,
        reason: `bun --version exited ${result.code}: ${result.stderr.slice(0, 200)}`,
      };
    }
    const version = result.stdout.trim();
    return {
      available: true,
      version: version || undefined,
    };
  } catch (err) {
    if (err instanceof BunNotFoundError) {
      return {
        available: false,
        reason: "Bun runtime not found on PATH. Install from https://bun.sh.",
      };
    }
    return {
      available: false,
      reason: `bun probe failed: ${(err as Error).message}`,
    };
  }
}

export interface OpencutVendorProbe {
  valid: boolean;
  /** The package.json `name` field when readable. */
  packageName?: string;
  /** The package.json `version` field when readable. */
  packageVersion?: string;
  /** Reason rendered in the UI when valid=false. */
  reason?: string;
}

/**
 * Validate that vendorPath looks like an OpenCut clone. Walks the
 * vendored monorepo to find apps/web/package.json (or the root
 * package.json) and matches "opencut" in the name. Lenient on purpose
 * so a fork named e.g. "opencut-foo" still validates -- exact-match
 * would lock out legitimate user forks.
 */
export async function validateOpencutVendor(
  vendorPath: string,
  opts: { readFile?: (p: string) => Promise<string> } = {},
): Promise<OpencutVendorProbe> {
  const readFile =
    opts.readFile ?? ((p: string) => fs.readFile(p, { encoding: "utf8" }));

  // OpenCut is a monorepo: the root package.json may not have "opencut"
  // in the name. Check apps/web/package.json first (the Next.js app),
  // fall back to root package.json.
  const candidates = [
    path.join(vendorPath, "apps", "web", "package.json"),
    path.join(vendorPath, "package.json"),
  ];

  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = await readFile(candidate);
    } catch {
      continue;
    }
    let pkg: { name?: unknown; version?: unknown };
    try {
      pkg = JSON.parse(raw) as { name?: unknown; version?: unknown };
    } catch {
      continue;
    }
    const name = typeof pkg.name === "string" ? pkg.name : undefined;
    const version = typeof pkg.version === "string" ? pkg.version : undefined;
    if (name && name.toLowerCase().includes("opencut")) {
      const result: OpencutVendorProbe = { valid: true };
      if (name) result.packageName = name;
      if (version) result.packageVersion = version;
      return result;
    }
  }

  return {
    valid: false,
    reason: `Vendor dir at "${vendorPath}" does not look like an OpenCut clone (no package.json with "opencut" in name found at root or apps/web/).`,
  };
}
