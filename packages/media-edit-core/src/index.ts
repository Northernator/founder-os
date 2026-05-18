// @founder-os/media-edit-core -- contract for the MEDIA_EDIT_READY pipeline stage.
//
// Slice 1 of the media-edit arc. Pure types + zod schemas + parse helpers +
// capability table + clip-manifest builder. No provider implementations, no
// subprocess spawn, no fs work -- those live in @founder-os/media-edit-providers
// (PM-split: client-safe barrel + /node subpath) once slice 2 lands.
//
// MEDIA_EDIT_READY is an OPTIONAL downstream stage between MEDIA_READY and
// LAUNCH. The founder can ship the raw stitched reel as-is, OR polish it in
// OpenCut. LAUNCH reads the edited reel when present, otherwise falls back
// to the raw one. Skipping is the default -- run-all-stages.ts only invokes
// the stage when manifest.mediaEdit.enabled === true.
//
// IMPORTANT: OpenCut is a Next.js web app (github.com/opencut-app/opencut),
// not a desktop binary. The provider lifecycle reflects this:
//   1. probe()            -- bun runtime + vendored OpenCut dir on disk
//   2. prepareWorkspace() -- write the clip-manifest markdown sidecar
//   3. launch()           -- spin up `bun dev` in the vendored dir, open
//                            default browser at http://localhost:<port>
//   4. awaitExport()      -- watch the export drop dir for the founder's
//                            manually-exported MP4
//   5. teardown()         -- optional; kill the long-running dev server
//
// The "clip manifest" is a Markdown table mapping render filenames to scene
// IDs + suggested timeline order. The founder reads it alongside the OpenCut
// UI and drags clips in by hand -- no project import is possible because
// OpenCut stores projects in browser IndexedDB (origin-scoped to localhost).
//
// Provider tier list (slice 1 ships the names + constants only):
//   tier_0: opencut       -- real, free, self-hosted Next.js + bun
//   tier_1: config_only   -- skip the edit step, ship the raw reel

import { z } from "zod";

// ---------------------------------------------------------------------------
// Engines + capability table
// ---------------------------------------------------------------------------

export const MediaEditEngineSchema = z.enum(["opencut", "config_only"]);
export type MediaEditEngine = z.infer<typeof MediaEditEngineSchema>;

export const DEFAULT_MEDIA_EDIT_ENGINE: MediaEditEngine = "opencut";

export type MediaEditCapability = {
  engine: MediaEditEngine;
  /** Pill label rendered in the UI ("OpenCut", "Skip edit"). */
  label: string;
  /** One-line description for help text / engine row tooltips. */
  description: string;
  /**
   * Whether the engine needs external local setup before probe() can
   * succeed. For opencut this means: bun runtime on PATH + a vendored
   * OpenCut copy under the configured vendor dir. config_only is
   * always available.
   */
  needsLocalSetup: boolean;
};

export const MEDIA_EDIT_CAPABILITIES: ReadonlyArray<MediaEditCapability> = [
  {
    engine: "opencut",
    label: "OpenCut",
    description:
      "Self-host the OpenCut Next.js editor. Provider runs `bun dev` in a vendored copy and opens the default browser; founder drag-drops clips from a manifest sidecar and exports back to 10_media/exports/edited/.",
    needsLocalSetup: true,
  },
  {
    engine: "config_only",
    label: "Skip edit",
    description:
      "No edit step -- LAUNCH uses the raw stitched reel from MEDIA_READY as-is.",
    needsLocalSetup: false,
  },
];

// ---------------------------------------------------------------------------
// Probe envelope (renderer <-> Tauri command crossing)
// ---------------------------------------------------------------------------

export const MediaEditProbeResultSchema = z.object({
  engine: MediaEditEngineSchema,
  available: z.boolean(),
  /** Resolved absolute path to the vendored editor dir when available. */
  vendorPath: z.string().optional(),
  /** Resolved absolute path to the runtime binary (e.g. bun). */
  runtimePath: z.string().optional(),
  /** Best-effort runtime version string. */
  version: z.string().optional(),
  /**
   * Free-form reason rendered in the UI when available=false:
   *  - opencut: "Bun runtime not found on PATH"
   *  - opencut: "Vendored OpenCut copy not found at <path>"
   *  - opencut: "Vendor dir exists but is not a valid OpenCut project"
   *  - config_only: never used; always available=true with no reason.
   */
  reason: z.string().optional(),
});
export type MediaEditProbeResult = z.infer<typeof MediaEditProbeResultSchema>;

// ---------------------------------------------------------------------------
// Spawn envelope -- for opencut, "spawn" starts the bun dev server AND
// opens the default browser. The server is long-running; teardown()
// kills it later.
// ---------------------------------------------------------------------------

export const MediaEditSpawnResultSchema = z.object({
  engine: MediaEditEngineSchema,
  spawned: z.boolean(),
  /** PID of the dev server when spawned=true. */
  pid: z.number().optional(),
  /**
   * Absolute path to the clip-manifest markdown the founder uses to
   * drag-drop clips in the right order.
   */
  manifestPath: z.string().optional(),
  /** HTTP URL the founder navigates to (e.g. http://localhost:3000). */
  serverUrl: z.string().optional(),
  /** Port the server listens on. */
  serverPort: z.number().optional(),
  /** True if launch() also triggered an OS-level browser tab open. */
  openedBrowser: z.boolean().optional(),
  /** Error message when spawned=false. */
  error: z.string().optional(),
});
export type MediaEditSpawnResult = z.infer<typeof MediaEditSpawnResultSchema>;

// ---------------------------------------------------------------------------
// Server status envelope -- renderer polls this for the "Server: running"
// pill in MediaEditTab.
// ---------------------------------------------------------------------------

export const MediaEditServerStatusSchema = z.object({
  engine: MediaEditEngineSchema,
  running: z.boolean(),
  url: z.string().optional(),
  port: z.number().optional(),
  pid: z.number().optional(),
  /** ISO timestamp the server was started; helps detect orphans. */
  startedAt: z.string().optional(),
});
export type MediaEditServerStatus = z.infer<typeof MediaEditServerStatusSchema>;

// ---------------------------------------------------------------------------
// Edit project export -- engine-agnostic intermediate representation
// ---------------------------------------------------------------------------

export const EditProjectSourceShotSchema = z.object({
  /** sceneId / shotId matching storyboard.json. */
  shotId: z.string(),
  /** Absolute path to the rendered MP4 under 10_media/renders/. */
  path: z.string(),
  durationSec: z.number().positive(),
  /** Optional human-readable label (storyboard.scene.onScreen text etc). */
  label: z.string().optional(),
});
export type EditProjectSourceShot = z.infer<typeof EditProjectSourceShotSchema>;

export const EditProjectBrandHintsSchema = z.object({
  primaryColor: z.string().optional(),
  accentColor: z.string().optional(),
  /** Absolute font file paths for the editor to import. */
  fontPaths: z.array(z.string()).optional(),
  /** Absolute logo path (PNG/SVG) for the editor to import. */
  logoPath: z.string().optional(),
});
export type EditProjectBrandHints = z.infer<typeof EditProjectBrandHintsSchema>;

/**
 * Engine-agnostic intermediate representation of what the founder is
 * supposed to assemble in the editor. The provider's prepareWorkspace()
 * serialises this into the editor's expected on-disk hints -- for
 * OpenCut that means the clip-manifest markdown (see
 * buildClipManifestMarkdown); a future native editor could turn this
 * into a real project file.
 */
export const EditProjectExportSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  ventureSlug: z.string(),
  engine: MediaEditEngineSchema,
  /** Source shots, in storyboard order. */
  shots: z.array(EditProjectSourceShotSchema),
  brandHints: EditProjectBrandHintsSchema.optional(),
  /**
   * Absolute path where the editor is expected to drop the final
   * exported MP4. The await-export step (slice 4) watches this
   * path's parent dir for OPENCUT_EXPORT_SENTINEL_FILENAME OR for the
   * MP4 itself to appear.
   */
  exportTargetPath: z.string(),
  generatedAt: z.string(),
});
export type EditProjectExport = z.infer<typeof EditProjectExportSchema>;

// ---------------------------------------------------------------------------
// Edited reel receipt -- await-export step's output
// ---------------------------------------------------------------------------

export const EditedReelReceiptSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  ventureSlug: z.string(),
  engine: MediaEditEngineSchema,
  /** Absolute path to the edited MP4 produced by the founder. */
  reelPath: z.string(),
  durationSec: z.number().positive().optional(),
  /** ISO timestamp when the watch-folder picked up the export. */
  exportedAt: z.string(),
  /** Free-form provider diagnostics (file size, codec, ffprobe meta). */
  meta: z.record(z.unknown()).optional(),
});
export type EditedReelReceipt = z.infer<typeof EditedReelReceiptSchema>;

// ---------------------------------------------------------------------------
// Per-venture media-edit config (manifest.mediaEdit in venture.yaml)
// ---------------------------------------------------------------------------

export const MediaEditConfigSchema = z.object({
  /**
   * When false or absent (default), MEDIA_EDIT_READY is skipped by
   * run-all-stages.ts. The founder must opt in explicitly per venture.
   */
  enabled: z.boolean().optional(),
  /**
   * Provider selection. Defaults to DEFAULT_MEDIA_EDIT_ENGINE when
   * enabled=true and engine is unset.
   */
  engine: MediaEditEngineSchema.optional(),
  /**
   * Override the dev-server port for opencut. Defaults to
   * DEFAULT_OPENCUT_DEV_PORT (3000). Set this when 3000 conflicts
   * with another local service.
   */
  serverPort: z.number().int().positive().optional(),
});
export type MediaEditConfig = z.infer<typeof MediaEditConfigSchema>;

// ---------------------------------------------------------------------------
// Cross-package constants
// ---------------------------------------------------------------------------

/**
 * Sentinel filename the await-export step polls/watches in the export
 * target directory. The provider's awaitExport() can write this once
 * the founder finishes their export (or it can simply watch for the
 * MP4 itself to appear). Constant here so both runner and provider
 * import the same name.
 */
export const OPENCUT_EXPORT_SENTINEL_FILENAME = ".opencut-export-state";

/**
 * Default filename for the edited reel inside 10_media/exports/edited/.
 * workspace-core's path helpers (slice 3) compose this with venture root.
 */
export const EDITED_REEL_FILENAME = "final-reel.mp4";

/**
 * Filename for the clip-manifest markdown the provider writes alongside
 * the renders. The founder reads this while drag-dropping clips into
 * OpenCut so they get the right order without rewatching everything.
 */
export const CLIP_MANIFEST_FILENAME = "clip-manifest.md";

/**
 * Default filename for the receipt awaitExport() emits, written
 * alongside the clip manifest under 10_media/edits/.
 */
export const EDIT_RECEIPT_FILENAME = "edit-receipt.json";

/**
 * Default port the vendored OpenCut dev server listens on. Matches
 * OpenCut upstream's default. Override via
 * manifest.mediaEdit.serverPort if it conflicts with another local
 * service (e.g. Founder OS's better-auth dev server).
 */
export const DEFAULT_OPENCUT_DEV_PORT = 3000;

/**
 * Leaf directory name under the user's vendor dir (e.g.
 * ~/.founder-os/vendor/<name>) where the provider keeps a vendored
 * OpenCut clone. Provider config can override the parent path; the
 * leaf name is fixed so probe() can find it deterministically.
 */
export const OPENCUT_VENDOR_DIRNAME = "opencut";

/**
 * Default timeout for awaitExport() in milliseconds. 24 hours -- the
 * founder may polish across multiple sessions. A timeout produces a
 * pending state (not a failure); slice 4's runner emits a review-gate
 * style "still waiting" log and the founder can resume.
 */
export const DEFAULT_AWAIT_EXPORT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Provider contract -- consumed by MediaEditStageRunner in slice 3-4
// ---------------------------------------------------------------------------

/**
 * Provider contract for the MEDIA_EDIT_READY stage. Implementations
 * live in @founder-os/media-edit-providers/node so this package stays
 * free of subprocess and fs dependencies.
 *
 * Lifecycle (orchestrated by MediaEditStageRunner):
 *   1. probe()            -- runtime + vendored editor checks. Cached
 *                            per run.
 *   2. prepareWorkspace() -- write the clip-manifest sidecar + any
 *                            other on-disk hints the editor needs.
 *   3. launch()           -- spin up the editor (for opencut: start
 *                            `bun dev`, open default browser at the
 *                            server URL).
 *   4. awaitExport()      -- block until the founder drops an exported
 *                            MP4 into exportTargetPath's parent dir,
 *                            or timeout (-> pending state, not failure).
 *   5. teardown()         -- optional cleanup of long-running resources
 *                            (kill the bun dev server when the stage
 *                            completes or aborts).
 *   6. status()           -- optional polling for the UI's
 *                            "Server: running" pill.
 *
 * config_only short-circuits the lifecycle: probe() always available,
 * prepareWorkspace()/launch()/awaitExport() are no-ops returning a
 * synthetic receipt pointing at the raw reel from MEDIA_READY.
 */
export interface MediaEditProvider {
  readonly name: MediaEditEngine;
  probe(): Promise<MediaEditProbeResult>;
  prepareWorkspace(input: EditProjectExport): Promise<{
    manifestPath: string;
    mediaDir: string;
  }>;
  launch(opts: { manifestPath: string }): Promise<MediaEditSpawnResult>;
  awaitExport(opts: {
    expectedPath: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<EditedReelReceipt>;
  teardown?(): Promise<void>;
  status?(): Promise<MediaEditServerStatus>;
}

// ---------------------------------------------------------------------------
// Parse helpers (the whole point of this package)
// ---------------------------------------------------------------------------

export function parseEditProjectExport(raw: unknown): EditProjectExport {
  return EditProjectExportSchema.parse(raw);
}
export function safeParseEditProjectExport(raw: unknown) {
  return EditProjectExportSchema.safeParse(raw);
}

export function parseEditedReelReceipt(raw: unknown): EditedReelReceipt {
  return EditedReelReceiptSchema.parse(raw);
}
export function safeParseEditedReelReceipt(raw: unknown) {
  return EditedReelReceiptSchema.safeParse(raw);
}

export function parseMediaEditConfig(raw: unknown): MediaEditConfig {
  return MediaEditConfigSchema.parse(raw);
}
export function safeParseMediaEditConfig(raw: unknown) {
  return MediaEditConfigSchema.safeParse(raw);
}

export function parseMediaEditProbeResult(raw: unknown): MediaEditProbeResult {
  return MediaEditProbeResultSchema.parse(raw);
}
export function safeParseMediaEditProbeResult(raw: unknown) {
  return MediaEditProbeResultSchema.safeParse(raw);
}

export function parseMediaEditSpawnResult(raw: unknown): MediaEditSpawnResult {
  return MediaEditSpawnResultSchema.parse(raw);
}
export function safeParseMediaEditSpawnResult(raw: unknown) {
  return MediaEditSpawnResultSchema.safeParse(raw);
}

export function parseMediaEditServerStatus(
  raw: unknown,
): MediaEditServerStatus {
  return MediaEditServerStatusSchema.parse(raw);
}
export function safeParseMediaEditServerStatus(raw: unknown) {
  return MediaEditServerStatusSchema.safeParse(raw);
}

// ---------------------------------------------------------------------------
// Capability lookup helpers
// ---------------------------------------------------------------------------

export function getMediaEditCapability(
  engine: MediaEditEngine,
): MediaEditCapability {
  const match = MEDIA_EDIT_CAPABILITIES.find((c) => c.engine === engine);
  if (!match) {
    throw new Error(`Unknown media-edit engine: ${engine}`);
  }
  return match;
}

/**
 * Resolve the effective engine for a venture's media-edit config. When
 * mediaEdit.enabled is false/absent the stage is skipped (caller's
 * responsibility -- this returns config_only as a defensive default).
 * When enabled and engine is unset, returns DEFAULT_MEDIA_EDIT_ENGINE.
 */
export function resolveMediaEditEngine(
  config: MediaEditConfig | undefined,
): MediaEditEngine {
  if (!config?.enabled) return "config_only";
  return config.engine ?? DEFAULT_MEDIA_EDIT_ENGINE;
}

// ---------------------------------------------------------------------------
// Clip-manifest builder (pure transformation, ships in the contract pkg
// the way handoff-providers' prompt-builder does)
// ---------------------------------------------------------------------------

/**
 * Turn an EditProjectExport into the Markdown sidecar the founder
 * reads while drag-dropping clips into OpenCut. Pure; no I/O.
 *
 * Output shape:
 *   - Heading + one-line "what to do" instruction
 *   - Numbered table of clips (#, scene id, duration, absolute path,
 *     optional label)
 *   - Brand hints section (colours, fonts, logo) when present
 *   - Export target section telling the founder where to export to
 */
export function buildClipManifestMarkdown(input: EditProjectExport): string {
  const lines: string[] = [];
  lines.push(`# Clip manifest -- ${input.ventureSlug}`);
  lines.push("");
  lines.push(
    "Drag these files into OpenCut's media panel in order, then arrange them on the timeline left-to-right.",
  );
  lines.push("");
  lines.push("| # | Scene | Duration | File | Note |");
  lines.push("|---|-------|----------|------|------|");
  input.shots.forEach((shot, idx) => {
    const num = String(idx + 1).padStart(2, "0");
    const dur = `${shot.durationSec.toFixed(1)}s`;
    const note = shot.label ?? "";
    lines.push(`| ${num} | ${shot.shotId} | ${dur} | ${shot.path} | ${note} |`);
  });
  lines.push("");
  if (input.brandHints) {
    const hints = input.brandHints;
    const hasContent =
      hints.primaryColor ||
      hints.accentColor ||
      hints.logoPath ||
      (hints.fontPaths && hints.fontPaths.length > 0);
    if (hasContent) {
      lines.push("## Brand hints");
      lines.push("");
      if (hints.primaryColor) {
        lines.push(`- Primary colour: \`${hints.primaryColor}\``);
      }
      if (hints.accentColor) {
        lines.push(`- Accent colour: \`${hints.accentColor}\``);
      }
      if (hints.fontPaths && hints.fontPaths.length > 0) {
        lines.push("- Fonts to import:");
        for (const f of hints.fontPaths) {
          lines.push(`  - \`${f}\``);
        }
      }
      if (hints.logoPath) {
        lines.push(`- Logo: \`${hints.logoPath}\``);
      }
      lines.push("");
    }
  }
  lines.push("## Export target");
  lines.push("");
  lines.push(`Export the final reel to: \`${input.exportTargetPath}\``);
  lines.push("");
  lines.push(
    "Founder OS watches that directory; once the file appears, MEDIA_EDIT_READY advances and LAUNCH will use the edited reel.",
  );
  lines.push("");
  return lines.join("\n");
}
