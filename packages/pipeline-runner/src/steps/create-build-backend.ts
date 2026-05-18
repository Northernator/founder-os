/**
 * createBuildBackendStep -- slice 6 of backend arc.
 *
 * Parallel to createBuildHandoffStep: BUILD now consumes
 * 12_backend/backend-export.json the same way it consumes
 * .founder/handoffs/handoff-export.json. The two bundles are
 * INDEPENDENT -- the VS Code extension can pick up either, both, or
 * (when running headless) neither.
 *
 * Bundle payload surfaces:
 *   - engine          which backend the venture provisioned (pocketbase /
 *                     supabase / convex / appwrite / drizzle_sqlite /
 *                     config_only)
 *   - baseUrl         where the runtime backend listens (http://127.0.0.1:8090
 *                     for tier_0 PocketBase, the hosted URL for tier_1+)
 *   - collections     the schema BUILD's frontend types against
 *   - auth.providers  the OAuth2 providers enabled at the auth collection
 *   - sdk.importPath  the alias BUILD must wire in its tsconfig paths
 *   - backendExportPath  echoed for older extension code paths
 *
 * Soft-required: if backend-export.json is missing or unparseable, the
 * step returns status: "skipped" and the runner does NOT emit a backend
 * bundle. That keeps ventures that haven't run BACKEND yet (or that
 * legitimately don't need a backend) able to BUILD their frontend.
 * Mirrors the BUILD_FROM_BRIEF fallback in createBuildHandoffStep.
 */
import type {
  BackendExport,
} from "@founder-os/backend-core";
import { safeParseBackendExport } from "@founder-os/backend-core";
import type { VentureManifest } from "@founder-os/domain";
import {
  type HandoffBundle,
  type HandoffRequestType,
} from "@founder-os/handoff-contract";
import { createBundle } from "@founder-os/handoff-desktop";
import { createLogger } from "@founder-os/logger";
import {
  getBackendExportPath,
  getHandoffsRoot,
} from "@founder-os/workspace-core";

import type { Filesystem } from "../fs.js";

const log = createLogger("pipeline-runner:create-build-backend");

export type CreateBuildBackendContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
};

export type CreateBuildBackendResult =
  | {
      status: "done";
      bundle: HandoffBundle;
      bundlePath: string;
      backendExport: BackendExport;
      backendExportPath: string;
    }
  | {
      status: "skipped";
      reason: string;
      backendExportPath: string;
    };

/**
 * Builds the backend handoff bundle the VS Code extension consumes.
 * Returns "skipped" + a human-readable reason when the BACKEND stage
 * hasn't run or the export is malformed -- those are non-fatal at the
 * BUILD layer (frontend can still ship with stubbed network calls).
 */
export async function createBuildBackendStep(
  ctx: CreateBuildBackendContext,
): Promise<CreateBuildBackendResult> {
  const backendExportPath = getBackendExportPath(ctx.ventureRoot);
  const backendExport = await tryLoadBackendExport(ctx.fs, backendExportPath);

  if (!backendExport) {
    return {
      status: "skipped",
      reason: `backend-export at ${backendExportPath} missing or unparseable -- run BACKEND stage first, or ignore for backend-less ventures`,
      backendExportPath,
    };
  }

  const handoffsRoot = getHandoffsRoot(ctx.ventureRoot);
  const inboxDir = `${handoffsRoot}/inbox`;
  await ctx.fs.mkdir(inboxDir);

  const bundleType: HandoffRequestType = "BUILD_FROM_BACKEND_EXPORT";

  const payload = {
    ventureName: ctx.manifest.name,
    appType: ctx.manifest.appType,
    engine: backendExport.engine,
    source: backendExport.source,
    baseUrl: backendExport.baseUrl,
    collections: backendExport.collections,
    collectionCount: backendExport.collections.length,
    auth: backendExport.auth,
    sdk: backendExport.sdk,
    sdkImportPath: backendExport.sdk.importPath,
    backendExportPath,
    backendExport,
    // Convenience: list of collection names is the smallest payload BUILD
    // needs to scaffold "what tables do we have?" Saves the extension
    // from walking the full Collection[] in the common case.
    collectionNames: backendExport.collections.map((c) => c.name),
  };

  const bundle = createBundle({
    ventureId: ctx.manifest.id,
    ventureRoot: ctx.ventureRoot,
    type: bundleType,
    artifactRefs: [],
    payload,
  });

  const bundlePath = `${inboxDir}/${bundle.runId}.json`;
  await ctx.fs.writeFile(bundlePath, JSON.stringify(bundle, null, 2));
  log.info(
    `Build backend bundle written -> ${bundlePath} (type=${bundleType}, engine=${backendExport.engine}, collections=${backendExport.collections.length}, sdk=${backendExport.sdk.importPath})`,
  );

  return {
    status: "done",
    bundle,
    bundlePath,
    backendExport,
    backendExportPath,
  };
}

/**
 * Best-effort load of backend-export.json. Returns null on any failure
 * (missing file, unreadable, invalid JSON, schema mismatch) and logs
 * the reason -- the caller returns "skipped" rather than throwing.
 * BuildStageRunner.validate() is the soft gatekeeper; this function
 * is permissive so the run() path can still produce *some* output if
 * the export got corrupted between validate and run.
 */
async function tryLoadBackendExport(
  fs: Filesystem,
  path: string,
): Promise<BackendExport | null> {
  if (!(await fs.exists(path))) {
    log.info(`No backend-export at ${path}; skipping backend bundle`);
    return null;
  }
  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch (err) {
    log.warn(
      `backend-export read failed (${err instanceof Error ? err.message : String(err)}); skipping`,
    );
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    log.warn(
      `backend-export JSON.parse failed (${
        err instanceof Error ? err.message : String(err)
      }); skipping`,
    );
    return null;
  }
  const parsed = safeParseBackendExport(json);
  if (!parsed.success) {
    log.warn(
      `backend-export schema mismatch (${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}); skipping`,
    );
    return null;
  }
  return parsed.data;
}
