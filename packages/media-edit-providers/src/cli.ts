#!/usr/bin/env tsx
/**
 * media-edit-providers Node sidecar CLI (slice 5b of media-edit arc).
 *
 * The Tauri WebView can't import @founder-os/media-edit-providers/node
 * directly because the renderer is browser-class -- node:child_process
 * and node:fs are externalised to stubs that throw on access (the
 * blank-screen failure mode documented in the media-providers PM-split
 * memory and the codesign launcher precedent).
 *
 * Solution mirrors the @founder-os/crm-providers and
 * @founder-os/backend-providers CLI shape: Tauri spawns a one-shot Node
 * process via `pnpm --filter @founder-os/media-edit-providers cli --`,
 * the CLI does the Node-only work (bun runtime probe + opencut clone
 * validation), and emits a JSON envelope on stdout that the Rust
 * command parses and returns to the WebView.
 *
 * Subcommands (slice 5b ships only the stateless probe -- serve/kill
 * are spawned directly from media_edit.rs because their lifecycle has
 * to survive the CLI process exit):
 *
 *   media-edit-providers probe-vendor --vendor-path <abs>
 *
 * Output contract: every successful run writes ONE JSON line to stdout
 * matching MediaEditProbeResult (from media-edit-core). Diagnostics go
 * to stderr.
 *
 * Errors: non-zero exit + `{"error": "..."}` on stdout so the Rust side
 * has a structured failure path even when something has gone sideways.
 */

import {
  probeBunRuntime,
  validateOpencutVendor,
} from "./node.js";

type ProbeVendorEnvelope =
  | {
      engine: "opencut";
      available: true;
      vendorPath: string;
      runtimePath?: string;
      version?: string;
    }
  | {
      engine: "opencut";
      available: false;
      reason: string;
      runtimePath?: string;
      version?: string;
    };

type ErrorEnvelope = { error: string };

function parseArg(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

async function main(): Promise<void> {
  // Strip the conventional `--` separator pnpm 10 forwards as a literal
  // argv entry (matches the crm/backend CLI pattern).
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "probe-vendor") {
      const vendorPath = parseArg(rest, "vendor-path");
      if (!vendorPath) {
        emitError("--vendor-path is required");
        return;
      }
      // Probe runtime first -- if bun isn't on PATH we still report
      // the vendor result so the UI can hint at both fixes at once.
      const bun = await probeBunRuntime();
      const vendor = await validateOpencutVendor(vendorPath);
      if (!bun.available) {
        const envelope: ProbeVendorEnvelope = {
          engine: "opencut",
          available: false,
          reason: bun.reason ?? "Bun runtime not found on PATH",
        };
        if (bun.version) envelope.version = bun.version;
        emit(envelope);
        return;
      }
      if (!vendor.valid) {
        const envelope: ProbeVendorEnvelope = {
          engine: "opencut",
          available: false,
          reason: vendor.reason ?? "Vendored OpenCut copy not found",
        };
        if (bun.version) envelope.version = bun.version;
        emit(envelope);
        return;
      }
      const envelope: ProbeVendorEnvelope = {
        engine: "opencut",
        available: true,
        vendorPath,
      };
      if (bun.version) envelope.version = bun.version;
      emit(envelope);
      return;
    }
    emitError(
      `unknown subcommand: ${cmd ?? "<none>"}. ` +
        `Known: probe-vendor`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitError(`media-edit-providers CLI: ${msg}`);
  }
}

function emit(envelope: ProbeVendorEnvelope): void {
  // Single JSON line on stdout -- the Rust side picks the last
  // non-empty line so any pnpm/tsx chatter above is ignored.
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function emitError(message: string): void {
  const env: ErrorEnvelope = { error: message };
  process.stdout.write(`${JSON.stringify(env)}\n`);
  process.exitCode = 1;
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  emitError(`media-edit-providers CLI top-level: ${msg}`);
});
