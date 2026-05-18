/**
 * codesign-launcher.ts -- WebView shim for the CoDesign Tauri commands.
 *
 * Slice 2 of the dual-handoff launcher arc. Mirrors the pattern from
 * probeHyperframesViaTauri (in run-media-stage.ts) and the CRM probe
 * helpers in run-crm-stage.ts:
 *
 *   1. invoke() the Rust command (apps/founder-desktop/src-tauri/src/codesign.rs)
 *   2. Parse the result with the zod schema from the client-safe
 *      @founder-os/handoff-providers barrel.
 *   3. Hand a typed envelope back to the caller.
 *
 * Why this lives client-side: the WebView cannot import
 * @founder-os/handoff-providers/node directly (Vite externalises
 * node:child_process + node:fs, the renderer crashes on access -- same
 * blank-screen failure mode the media-providers PM-split memory documents).
 * The root barrel "@founder-os/handoff-providers" is the only safe
 * import surface from this file.
 *
 * Slice 3 will consume these helpers from ScreensTab's
 * "Run handoff (CoDesign)" handler: probe -> write prompt to clipboard
 * -> spawn -> show pill state.
 */

import {
  HandoffProbeResultSchema,
  HandoffSpawnResultSchema,
  type HandoffProbeResult,
  type HandoffSpawnResult,
} from "@founder-os/handoff-providers";
import { invoke } from "@tauri-apps/api/core";

/**
 * Probe whether Open CoDesign is launchable on the user's machine.
 *
 * Returns a parsed HandoffProbeResult envelope. Never throws under
 * normal operation -- a missing binary yields `available: false` with a
 * `reason` string. Throws only when:
 *   - Tauri isn't ready (e.g. called outside the WebView).
 *   - The pnpm sidecar fails to start at all (no binary on PATH, etc).
 *   - The CLI emits malformed JSON.
 *
 * @param binary Optional override path -- skips the candidate sweep on
 *   the Node side and trusts the caller. Used by power users with
 *   non-standard install locations.
 */
export async function probeCodesignViaTauri(
  binary?: string,
): Promise<HandoffProbeResult> {
  const raw = await invoke<unknown>("codesign_probe", { binary });
  const parsed = HandoffProbeResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `codesign_probe returned a malformed envelope: ${parsed.error.message}\nraw: ${JSON.stringify(raw)}`,
    );
  }
  return parsed.data;
}

/**
 * Spawn Open CoDesign detached. Returns once the child process has a PID.
 * The launcher window lives on past this resolution; the renderer should
 * have already written the synthesized prompt to the OS clipboard via
 * `navigator.clipboard.writeText()` before calling this.
 *
 * Returns a parsed HandoffSpawnResult envelope. spawned=false is a
 * normal outcome (binary not found / spawn errored) -- callers should
 * branch on the envelope, not on thrown errors. Only throws when:
 *   - Tauri isn't ready.
 *   - The pnpm sidecar fails to start.
 *   - The CLI emits malformed JSON.
 */
export async function spawnCodesignViaTauri(
  binary?: string,
): Promise<HandoffSpawnResult> {
  const raw = await invoke<unknown>("codesign_spawn", { binary });
  const parsed = HandoffSpawnResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `codesign_spawn returned a malformed envelope: ${parsed.error.message}\nraw: ${JSON.stringify(raw)}`,
    );
  }
  return parsed.data;
}

/**
 * Convenience aggregate -- 5-state pill status for the CoDesign engine.
 * Same shape as HfStatus / CrmEngineStatus so ScreensTab can share a
 * pill renderer in slice 3 if desired.
 *
 *  - probing       initial state while invoke() is in flight
 *  - ready         probe ok, binary found
 *  - not-installed probe ok, binary missing (graceful -- triggers fallback preview window)
 *  - probe-failed  probe threw (Tauri sidecar crashed)
 *  - launching     spawn() in flight
 *  - launched      spawned ok
 *  - spawn-failed  spawn() returned spawned=false with an error
 */
export type CodesignPillState =
  | "idle"
  | "probing"
  | "ready"
  | "not-installed"
  | "probe-failed"
  | "launching"
  | "launched"
  | "spawn-failed";

/**
 * Short pill label per state -- shown next to the "Run handoff
 * (CoDesign)" button in ScreensTab. Kept here so slice 4's preview
 * window (and any future surface) can reuse the same vocabulary.
 */
export const CODESIGN_PILL_LABEL: Record<CodesignPillState, string> = {
  idle: "Idle",
  probing: "Probing...",
  ready: "Ready",
  "not-installed": "Not installed",
  "probe-failed": "Probe failed",
  launching: "Launching...",
  launched: "Launched",
  "spawn-failed": "Spawn failed",
};

/** Longer hover-tooltip description per state. */
export const CODESIGN_PILL_DESCRIPTIONS: Record<CodesignPillState, string> = {
  idle: "Run the handoff to launch CoDesign.",
  probing: "Checking whether Open CoDesign is installed on this machine...",
  ready: "Open CoDesign binary found.",
  "not-installed":
    "Open CoDesign not found on PATH or in known install locations. Install via brew/scoop/winget, or use the in-app preview window fallback.",
  "probe-failed":
    "The probe round trip threw an error (Tauri sidecar crashed or pnpm couldn't start the CLI). Check the toast for details.",
  launching: "Spawning Open CoDesign detached...",
  launched:
    "Open CoDesign launched. Paste your clipboard (Ctrl/Cmd+V) into its prompt box to start.",
  "spawn-failed":
    "The binary was found but spawn() failed. Check the toast for the OS-level error. Your prompt is still on the clipboard.",
};

/** Visual style per state. CSS variables match the rest of the app. */
export const CODESIGN_PILL_STYLE: Record<
  CodesignPillState,
  { bg: string; border: string; fg: string }
> = {
  idle: {
    bg: "var(--bg-elevated)",
    border: "var(--border-subtle)",
    fg: "var(--text-muted)",
  },
  probing: {
    bg: "var(--warning-soft, #3a2a14)",
    border: "var(--warning-border, #6b4a1f)",
    fg: "var(--warning-fg, #f4ba60)",
  },
  ready: {
    bg: "var(--success-soft, #18331f)",
    border: "var(--success-border, #2a5c39)",
    fg: "var(--success-fg, #6cd28c)",
  },
  "not-installed": {
    bg: "var(--bg-elevated)",
    border: "var(--border-subtle)",
    fg: "var(--text-muted)",
  },
  "probe-failed": {
    bg: "var(--danger-soft, #3a1a1a)",
    border: "var(--danger-border, #6b2e2e)",
    fg: "var(--danger-fg, #ee7676)",
  },
  launching: {
    bg: "var(--warning-soft, #3a2a14)",
    border: "var(--warning-border, #6b4a1f)",
    fg: "var(--warning-fg, #f4ba60)",
  },
  launched: {
    bg: "var(--success-soft, #18331f)",
    border: "var(--success-border, #2a5c39)",
    fg: "var(--success-fg, #6cd28c)",
  },
  "spawn-failed": {
    bg: "var(--danger-soft, #3a1a1a)",
    border: "var(--danger-border, #6b2e2e)",
    fg: "var(--danger-fg, #ee7676)",
  },
};
