/**
 * Shared types for @founder-os/handoff-providers.
 *
 * CLIENT-SAFE -- no node:* imports. The WebView and the Node side both
 * speak the same envelope shapes, validated with zod when crossing the
 * IPC boundary (Tauri command -> webview).
 *
 * Mirrors the shape established by @founder-os/crm-providers (probe/spawn
 * envelopes) and @founder-os/media-providers (provider capabilities).
 */
import { z } from "zod";

// Handoff providers we know about. Slice 1 ships only `codesign`. The
// `stitch` and `figma` slots are reserved so the capability table can
// grow without renaming. `none` is a sentinel for "no launcher acted on
// this handoff" -- consumers should treat it like a no-op.
export const HandoffLauncherEngineSchema = z.enum([
  "codesign",
  "stitch",
  "figma",
  "none",
]);
export type HandoffLauncherEngine = z.infer<typeof HandoffLauncherEngineSchema>;

/**
 * What the WebView knows about each launcher without doing any work.
 * The actual `probe()` lives in /node and is reached from the renderer
 * via a Tauri command (apps/founder-desktop/src-tauri/src/codesign.rs).
 */
export type HandoffLauncherCapability = {
  engine: HandoffLauncherEngine;
  /** Pill label rendered in the UI ("CoDesign", "Stitch", "Figma"). */
  label: string;
  /** One-line description for help text / engine row tooltips. */
  description: string;
  /**
   * Whether the launcher needs an external binary on the user's machine.
   * `none` is false; everything else true. Drives whether the probe pill
   * is shown at all.
   */
  needsBinary: boolean;
};

export const HANDOFF_LAUNCHER_CAPABILITIES: ReadonlyArray<HandoffLauncherCapability> = [
  {
    engine: "codesign",
    label: "CoDesign",
    description:
      "Open CoDesign (Electron). Clipboard-paste prompt injection. Falls back to in-app preview.",
    needsBinary: true,
  },
  {
    engine: "stitch",
    label: "Stitch",
    description:
      "Reserved -- Stitch handoff is prompt-only today and does not need a launcher.",
    needsBinary: false,
  },
  {
    engine: "figma",
    label: "Figma",
    description: "Reserved -- not yet implemented.",
    needsBinary: true,
  },
  {
    engine: "none",
    label: "No launcher",
    description: "Generate the handoff artefact only; do not launch any external tool.",
    needsBinary: false,
  },
];

// --- Probe envelope ------------------------------------------------------
//
// The renderer asks "is the binary for engine X available?". The Tauri
// command answers with this shape; the Node-side launcher returns the
// same shape from its own probe() so the CLI and the desktop see the
// same data.

export const HandoffProbeResultSchema = z.object({
  engine: HandoffLauncherEngineSchema,
  /** True if the binary is on PATH or in a known install location. */
  available: z.boolean(),
  /** Resolved absolute path when available; undefined when not. */
  path: z.string().optional(),
  /**
   * Best-effort version string (parsed from `--version` output if the
   * launcher supports it). Undefined when unknown -- never blocks
   * available=true.
   */
  version: z.string().optional(),
  /**
   * Free-form reason rendered in the UI when available=false:
   *  - codesign: "Open CoDesign not found on PATH or in known install dirs"
   *  - figma:    "Figma launcher not yet implemented"
   *  - none:     never used; always available=true with no reason.
   */
  reason: z.string().optional(),
});
export type HandoffProbeResult = z.infer<typeof HandoffProbeResultSchema>;

// --- Spawn envelope ------------------------------------------------------
//
// The renderer asks "launch the binary for engine X (clipboard prompt is
// already in place)". The Tauri command spawns it detached and answers
// with this shape so the renderer can show a toast / pill state.

export const HandoffSpawnResultSchema = z.object({
  engine: HandoffLauncherEngineSchema,
  /** True if spawn() resolved without throwing ENOENT or similar. */
  spawned: z.boolean(),
  /** Process id when spawned=true; undefined otherwise. */
  pid: z.number().optional(),
  /** Resolved absolute path of the binary actually launched. */
  path: z.string().optional(),
  /** Error message when spawned=false. */
  error: z.string().optional(),
});
export type HandoffSpawnResult = z.infer<typeof HandoffSpawnResultSchema>;

// --- Prompt builder envelope --------------------------------------------
//
// The renderer hands the launcher a CoDesign-shaped HandoffExport plus
// the BrandBrief; the launcher returns a single Markdown prompt string
// the renderer can drop into the OS clipboard. Pure transformation;
// stored in this file so the client-safe barrel can re-export it.

export type HandoffPromptResult = {
  /** The Markdown prompt ready to paste into Open CoDesign. */
  prompt: string;
  /** Length in characters -- handy for the UI to show "Pasted N chars". */
  characters: number;
  /** Number of screens enumerated in the prompt (drives banner text). */
  screenCount: number;
};
