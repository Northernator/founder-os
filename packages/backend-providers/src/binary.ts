/**
 * PocketBase binary lifecycle helpers.
 *
 * Slice 2 ships path resolution + existence probe + the download
 * function as a contract-only stub. Slice 4 fills in the actual zip
 * download + extract path; until then the user can drop a release
 * binary into 12_backend/pocketbase/ manually and provision() will
 * detect it.
 *
 * The path layout matches the spec sec 3 exactly:
 *
 *   <ventureRoot>/12_backend/pocketbase/
 *     pocketbase(.exe)       <- this file
 *     pb_data/               <- runtime state (gitignored, created on serve)
 *     pb_migrations/         <- written by ensure-project.ts
 *     pb_hooks/              <- written by ensure-project.ts
 *
 * Why the download is deferred to slice 4: extracting the official PB
 * release zips needs either a third-party zip dep (decompress / adm-zip)
 * or a careful node-only PKZIP reader. Slice 2 keeps the dep surface to
 * @founder-os/backend-core + zod + node stdlib, so we lock the function
 * shape now and fill the body later. The contract surface (errors +
 * argument types) is final.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { POCKETBASE_DEFAULT_VERSION, POCKETBASE_DOWNLOAD_BASE } from "@founder-os/backend-core";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PocketbaseBinaryMissingError extends Error {
  override readonly name = "PocketbaseBinaryMissingError";
  constructor(
    readonly binaryPath: string,
    readonly downloadUrl: string
  ) {
    super(
      `PocketBase binary not present at ${binaryPath}. ` +
        `Download from ${downloadUrl} and unzip into the same directory, ` +
        "or wait for slice 4 to auto-download. (slice 2 only locks the contract.)"
    );
  }
}

export class PocketbaseBinaryDownloadError extends Error {
  override readonly name = "PocketbaseBinaryDownloadError";
  constructor(readonly version: string, override readonly cause?: unknown) {
    super(`PocketBase binary download failed for version ${version}`);
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Returns the absolute filesystem path the venture's PocketBase binary
 * lives at. Used by the provider in available() + spawn calls.
 */
export function resolveBinaryPath(ventureRoot: string): string {
  const name = process.platform === "win32" ? "pocketbase.exe" : "pocketbase";
  return join(ventureRoot, "12_backend", "pocketbase", name);
}

/**
 * Synchronous file-exists check. Used in available() which is hot-pathed
 * by the resolver -- async fs.access here would mean every probe waits
 * on the event loop. existsSync is one stat call.
 */
export function binaryExists(binaryPath: string): boolean {
  return existsSync(binaryPath);
}

/**
 * Returns the canonical download URL the user should pull from when
 * they manually install the binary (slice 2) or that the auto-download
 * routine should target (slice 4+).
 *
 * Platform mapping mirrors the PocketBase release artifact naming:
 *   pocketbase_<ver>_linux_amd64.zip
 *   pocketbase_<ver>_linux_arm64.zip
 *   pocketbase_<ver>_darwin_amd64.zip
 *   pocketbase_<ver>_darwin_arm64.zip
 *   pocketbase_<ver>_windows_amd64.zip
 */
export function resolveDownloadUrl(
  version: string = POCKETBASE_DEFAULT_VERSION
): string {
  const os =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "darwin"
        : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  // Strip wildcard suffix (.x) -- the user is expected to resolve a
  // concrete version (e.g. "0.22.20") before passing it through the
  // download URL. Slice 4 will lookup the latest matching tag.
  const concrete = version.replace(/\.x$/, "");
  return `${POCKETBASE_DOWNLOAD_BASE}/v${concrete}/pocketbase_${concrete}_${os}_${arch}.zip`;
}

// ---------------------------------------------------------------------------
// Download (deferred to slice 4)
// ---------------------------------------------------------------------------

export type DownloadBinaryOpts = {
  binaryPath: string;
  version?: string;
  /**
   * Optional injected fetcher. Defaults to globalThis.fetch.bind. Tests
   * pass a stub.
   */
  fetchImpl?: typeof fetch;
};

/**
 * Slice 4 placeholder. Throws PocketbaseBinaryDownloadError with a
 * pointer at the manual download URL so the user can drop the binary
 * in by hand until the implementation lands.
 *
 * The function signature is the contract -- once slice 4 ships the
 * real implementation, callers won't need to change.
 */
export async function downloadBinary(opts: DownloadBinaryOpts): Promise<void> {
  const url = resolveDownloadUrl(opts.version);
  throw new PocketbaseBinaryDownloadError(
    opts.version ?? POCKETBASE_DEFAULT_VERSION,
    `Auto-download not implemented in slice 2. Manually fetch ${url} and unzip into ` +
      `the directory containing ${opts.binaryPath}.`
  );
}
