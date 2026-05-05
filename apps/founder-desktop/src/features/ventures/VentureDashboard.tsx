import { ProjectChat } from "@founder-os/chat-ui";
import type { ChatMessage } from "@founder-os/chat-ui";
import type { ChatAttachment } from "@founder-os/chat-ui";
import type { StageName, Venture, VentureManifest, VentureStage } from "@founder-os/domain";
import { VentureManifestSchema } from "@founder-os/domain";
import { StageGraph } from "@founder-os/graph-ui";
import { PROVIDER_CATALOG, getProvider } from "@founder-os/llm-providers";
import { runPipeline } from "@founder-os/pipeline-runner";
import { optimize } from "@founder-os/prompt-master";
import {
  STAGE_FIRST_MESSAGE,
  baseSystemPrompt,
  brandStagePrompt,
  buildStagePrompt,
  researchStagePrompt,
  saasResearchIntakePrompt,
  screensStagePrompt,
  specStagePrompt,
  ukSetupStagePrompt,
} from "@founder-os/prompts";
import { usePipelineStore, useVentureStore } from "@founder-os/state";
import { Button, Card, StageBadge } from "@founder-os/ui";
import { invoke } from "@tauri-apps/api/core";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type AdvancePreflight,
  nextStageAfter,
  runAdvancePreflight,
} from "../../lib/advance-gate.js";
import { buildAttachmentBlock, extractAttachment } from "../../lib/chat-attachments.js";
import * as db from "../../lib/db.js";
import { pickActiveProvider, streamChat } from "../../lib/llm-client.js";
import { tauriFs } from "../../lib/pipeline-fs.js";
import { buildPipelineLlmCaller } from "../../lib/pipeline-llm.js";
import { runResearchStage } from "../../lib/run-research-stage.js";
import { pushToast } from "../../lib/toasts.js";
import { useAbortableTask } from "../../lib/use-abortable-task.js";
import { deleteVentureDir, loadVentureManifest, openInFileManager } from "../../lib/venture-io.js";
import { ArtifactsTab } from "./ArtifactsTab.js";
import { AuditTab } from "./AuditTab.js";
import { BrandTab } from "./BrandTab.js";
import { IdeaTab } from "./IdeaTab.js";
import { OptionsTab } from "./OptionsTab.js";
import { PendingReviewsPanel } from "./PendingReviewsPanel.js";
import { PipelineStatusPanel } from "./PipelineStatusPanel.js";
import { ResearchTab } from "./ResearchTab.js";
import { RunAllStagesButton } from "./RunAllStagesButton.js";
import { SalesTab } from "./SalesTab.js";
import { ScreensTab } from "./ScreensTab.js";
import { SpecTab } from "./SpecTab.js";
import { UkSetupTab } from "./UkSetupTab.js";
import { ValidationTab } from "./ValidationTab.js";
import { VentureProviderPicker } from "./VentureProviderPicker.js";

/**
 * Dashboard-side attachment record. Extends the chat-ui `ChatAttachment`
 * (which only has UI-facing state) with the extracted text so handleSend
 * can concatenate it into the outgoing user message.
 *
 * Kept in local state rather than a store: attachments are per-composer
 * and don't need to survive tab switches. If the user switches ventures,
 * the state resets via the venture-id-keyed effect below.
 */
type DashboardAttachment = ChatAttachment & { text?: string };

type Tab =
  | "idea"
  | "research"
  | "validation"
  | "brand"
  | "uk-setup"
  | "spec"
  | "screens"
  | "overview"
  | "chat"
  | "pipeline"
  | "artifacts"
  | "sales"
  | "audit"
  | "options";

function makeMsgId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Cue the assistant emits in the SaaS research intake when it thinks it
 * has enough signal to generate the Core 4 reports. See the wording in
 * `saasResearchIntakePrompt()`. We match on the bare token — assistants
 * occasionally fumble the exact surrounding formatting but the token
 * itself is distinctive enough to avoid false positives.
 *
 * Keep this in sync with the prompt's instructions.
 */
const READY_CUE = "READY_TO_GENERATE_REPORTS";

/**
 * Brand stage cues emitted by `brandStagePrompt()`. The UI surfaces
 * a one-shot toast when either transitions false→true, pointing the
 * user at the Brand tab. Unlike the SaaS READY cue these don't drive
 * a single button — the Brand tab has its own buttons — so the cue's
 * job is purely to say "hey, the assistant thinks you're ready, go
 * act on it".
 */
const BRAND_NAMING_CUE = "NAMING_CANDIDATES_READY";
const BRAND_DIRECTION_CUE = "BRAND_DIRECTION_READY";

/**
 * UK Setup stage cue (pt.34a). Emitted by `ukSetupStagePrompt()` when the
 * coach thinks the founder has covered the entity / HMRC / banking /
 * insurance / IP basics enough to advance to Spec. Same edge-detector
 * pattern as the brand cues — one-shot toast, no button driven by it.
 *
 * Keep this in sync with the prompt's instructions.
 */
const UK_SETUP_CUE = "UK_SETUP_READY";

/**
 * Spec stage cue (pt.41g). Emitted by `specStagePrompt()` when the
 * coach thinks the canvas covers the must-haves (purpose, persona,
 * Must features with AC, scope, entity, endpoint, NFR, metric).
 * Same one-shot toast pattern as the UK Setup cue.
 */
const SPEC_CUE = "SPEC_READY";

/**
 * Screens stage cue (pt.45). Emitted by `screensStagePrompt()` when
 * the coach thinks the screen inventory covers the Must features.
 * Token matches the legacy stage enum value (`WIREFRAME_READY`)
 * deliberately — the user-facing label is "Screens" everywhere but
 * the underlying stage stays `WIREFRAME_READY` to avoid a 13-file
 * rename + DB migration. See screens.ts for the full naming
 * compromise.
 */
const WIREFRAME_CUE = "WIREFRAME_READY";

/**
 * Scan messages newest-first for an assistant message containing the
 * ready cue. Returns true only if the MOST RECENT assistant message
 * contains the cue — so a follow-up user question or a later assistant
 * message without the cue naturally "turns off" the highlight.
 *
 * Rationale for last-assistant-only: if the assistant said "READY" three
 * turns ago, then asked a refining question, the user has clearly moved
 * back into discovery. Keep the button calm until the cue reappears.
 */
function assistantJustCuedReports(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    return m.content.includes(READY_CUE);
  }
  return false;
}

/** Same last-assistant-only scan but matching any of the brand cues. */
function lastAssistantIncludes(messages: ChatMessage[], needle: string): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    return m.content.includes(needle);
  }
  return false;
}

/**
 * Compose the system prompt for a chat send.
 *
 * Keeps the layered prompt logic in one place so handleSend stays readable
 * and the wiring can be unit-tested later without a React component.
 *
 * Layers (outer → inner):
 *   1. baseSystemPrompt(manifest) — venture identity (name, stage, appType,
 *      entityType, regulated/payments/PII flags, blockers)
 *   2. stage-specific guidance — research / brand / build
 *   3. intake / workflow overlays — e.g. SaaS research intake
 *
 * Fallback: if the manifest hasn't loaded yet (first paint, missing YAML,
 * read error), we return the old terse coach string so the chat still
 * works. The next send after hydration picks up the richer composition.
 */
function buildSystemPromptForSend(args: {
  ventureName: string;
  ventureStage: VentureStage;
  manifest: VentureManifest | null;
}): string {
  const { ventureName, ventureStage, manifest } = args;

  if (!manifest) {
    return `You are the Founder OS AI coach for the venture "${ventureName}". The founder is currently at stage: ${ventureStage.replace(/_/g, " ")}. Be concise, practical, and business-savvy. Offer concrete next actions where helpful.`;
  }

  const parts: string[] = [baseSystemPrompt(manifest)];

  // Stage overlay — one of research / brand / build. Other stages fall
  // through with just the base prompt for now; we'll add overlays as we
  // build out each stage's workflow.
  if (ventureStage === "RESEARCHED") {
    parts.push(researchStagePrompt());
    // SaaS-specific intake: the assistant guides a structured discovery
    // conversation that feeds the Core 4 reports generator. Gated on
    // appType so other app types (web, game, desktop, etc.) keep the
    // generic research prompt for now.
    if (manifest.appType === "saas") {
      parts.push(saasResearchIntakePrompt());
    }
  } else if (ventureStage === "VALIDATED" || ventureStage === "BRAND_READY") {
    // VALIDATED also gets the brand overlay — the founder advances into
    // the Brand tab directly from Validation (see STAGE_TAB) so the
    // chat should be coaching on naming / direction even before the
    // explicit BRAND_READY stage flip.
    parts.push(brandStagePrompt());
  } else if (ventureStage === "UK_SETUP_READY") {
    // pt.33: UK admin coaching. The chat is for the messy questions
    // a structured form can't capture (entity choice, SIC code
    // ambiguity, insurance posture). The UkSetupTab is the canvas;
    // this prompt is the conversation alongside it.
    parts.push(ukSetupStagePrompt());
  } else if (ventureStage === "SPEC_READY") {
    // pt.41: Spec stage coaching. Pushes back on vagueness, gold-
    // plating, persona-of-one, over-modelled data. The SpecTab is
    // the structured canvas; this prompt is the messy thinking
    // alongside it (purpose framing, MoSCoW judgement calls,
    // acceptance criteria specificity).
    parts.push(specStagePrompt());
  } else if (ventureStage === "WIREFRAME_READY") {
    // pt.45: Screens stage coaching. Pushes back on too-granular
    // inventories, shell-type-as-decoration, feature-mapping
    // mismatches. The ScreensTab is the structured canvas; this
    // prompt is the messy "is this the right cut of screens"
    // conversation alongside it. Stage enum is still
    // WIREFRAME_READY (legacy) but everything user-facing is
    // "Screens"; see screens.ts header for the naming compromise.
    parts.push(screensStagePrompt());
  } else if (
    ventureStage === "BUILD_READY" ||
    ventureStage === "STITCH_READY" ||
    ventureStage === "AUDIT_READY"
  ) {
    parts.push(buildStagePrompt());
  }

  return parts.join("\n\n");
}

/**
 * Serialise a chat thread to Markdown for export.
 *
 * Shape: a small metadata header (venture / stage / count / export date),
 * then one H2 section per message with a role label + ISO timestamp.
 * Welcome bubbles are filtered out — they're a render-time affordance,
 * not real thread content.
 *
 * Attachment content is preserved verbatim: `buildAttachmentBlock` (see
 * chat-attachments.ts) prepends fenced `--- BEGIN ATTACHMENT ---` blocks
 * into the user message itself at send time, so they're already part of
 * `msg.content`. The LLM saw them; the export should show them too.
 *
 * Format chosen: Markdown rather than plain text. Renders fine in any
 * text viewer, round-trips cleanly into another LLM as context, and
 * preserves the code fences / tables the assistant produced.
 */
function buildChatMarkdown(args: {
  ventureName: string;
  stage: VentureStage;
  messages: ChatMessage[];
  exportedAt: Date;
}): string {
  const { ventureName, stage, messages, exportedAt } = args;
  // Defensive — the synthetic "welcome" message never hits the persisted
  // state in practice, but filter anyway so copy-paste into another
  // session doesn't re-seed a fake first turn.
  const real = messages.filter((m) => m.id !== "welcome");

  const prettyStage = stage.replace(/_/g, " ");
  const lines: string[] = [];

  lines.push(`# Chat export — ${ventureName}`);
  lines.push("");
  lines.push(`- **Venture:** ${ventureName}`);
  lines.push(`- **Stage:** ${prettyStage}`);
  lines.push(`- **Messages:** ${real.length}`);
  lines.push(`- **Exported:** ${exportedAt.toISOString()}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const msg of real) {
    // Plain-text role labels — survive copy/paste into any editor or tool
    // without a fallback glyph, and keep the output readable in a terminal.
    const label =
      msg.role === "user" ? "Founder" : msg.role === "assistant" ? "Assistant" : msg.role;
    lines.push(`## ${label} — ${msg.createdAt}`);
    lines.push("");
    // content can contain code fences / ATX headers; we don't mutate it.
    // A trailing newline guarantees the next H2 starts on a fresh line
    // even if the model didn't end its reply with one.
    lines.push(msg.content);
    lines.push("");
  }

  // Stable trailing newline — makes diffs cleaner if the same thread
  // gets re-exported after more turns.
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Shared style for items in the Save-Chat dropdown. Module-level so the
 * object identity is stable across renders — avoids pointless re-styling
 * when the dropdown opens. Hover/active states are skipped intentionally
 * (inline style doesn't support pseudo-classes); the dropdown is small
 * enough that hover feedback isn't worth pulling in a style block.
 */
const chatExportMenuItemStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "8px 12px",
  background: "transparent",
  border: "none",
  fontSize: 13,
  color: "#111827",
  cursor: "pointer",
};

/**
 * Windows-safe default filename for a chat export. Short venture id +
 * lowercased stage + ISO date — sortable in a folder, no colons, no
 * spaces, no slashes.
 */
function defaultChatExportFilename(ventureId: string, stage: VentureStage, now: Date): string {
  const short = ventureId.slice(0, 8);
  const stageSlug = stage.toLowerCase();
  const date = now.toISOString().slice(0, 10);
  return `founder-os-chat-${short}-${stageSlug}-${date}.md`;
}

// biome-ignore lint/correctness/noUnusedVariables: kept for future use / interface compatibility
export function VentureDashboard({ ventureId }: { ventureId: string }) {
  const { activeVenture, updateVentureStage, removeVenture, setError, error } = useVentureStore();
  const { activePlan, setActivePlan, updateActivePlan, setRunning, isRunning } = usePipelineStore();
  // Default to "idea" tab for IDEA-stage ventures so the guided walkthrough
  // is the first thing the founder sees. Any other stage defaults to "overview".
  const [tab, setTab] = useState<Tab>("overview");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  // Optimistic "Stopping…" flag — set the instant the user hits the chat Stop
  // button, cleared when the stream settles (done / cancel / error). Kept as
  // state (not a ref) because it drives the button's label + disabled state;
  // we want an immediate re-render rather than waiting for the next reason
  // React happens to re-render. Defensive against the Rust cancel taking a
  // few hundred ms to round-trip and hit onCancel.
  const [chatStopping, setChatStopping] = useState(false);
  const [stageSaving, setStageSaving] = useState(false);
  const [chatHydrating, setChatHydrating] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteFromDisk, setDeleteFromDisk] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Bumped after each pipeline run to trigger an Artifacts re-scan. The tab
  // owns its own state, so this is the cheapest way to nudge it from here.
  const [artifactsRescanToken, setArtifactsRescanToken] = useState(0);
  // Running total of tokens that Prompt Master shaved off this venture's
  // chat session. Reset on venture switch (see effect below). Surfaced as
  // a small footer on the chat composer so the founder gets a passive
  // signal that the optimizer is doing real work.
  const [promptMasterTokensSaved, setPromptMasterTokensSaved] = useState(0);
  // Same idea for the Audit tab — bumped after a pipeline run so the
  // tab refreshes even if the user wasn't looking at it during the run.
  const [auditRefreshToken, setAuditRefreshToken] = useState(0);
  // AbortController for the in-flight chat stream. Ref (not state) because
  // the Stop button's visibility is keyed on `chatLoading` — the controller's
  // presence doesn't drive render. Cleared whenever a stream settles
  // (done / cancel / error) so a stale reference can't cancel a fresh send.
  const chatAbortRef = useRef<AbortController | null>(null);

  // pt.28 / pt.29 / pt.30a: abort plumbing for the two long-running
  // tasks invoked from this dashboard. The hook bundles the
  // (ref + stopping flag + cancel + wasCancelled discriminator) shape
  // that grew up in three places independently. Chat keeps its inline
  // version (chatAbortRef / chatStopping) because it has additional
  // partial-text preservation logic that doesn't fit the simple shape.
  //
  // pipelineTask: brand pipeline run. Aborting cancels any in-flight
  // LLM call inside `generate-naming-candidates` / `generate-logo-concepts`.
  // pt.30c lets the orchestrator also bail between steps when the
  // signal is aborted, so deterministic steps after a cancel don't
  // continue churning.
  const pipelineTask = useAbortableTask();
  // reportsTask: SaaS research-reports generator. 4 parallel LLM calls
  // share one signal via closure capture inside `buildPipelineLlmCaller`;
  // a single abort terminates all of them.
  const reportsTask = useAbortableTask();

  // Cached venture.yaml manifest. Loaded lazily on venture switch so the
  // chat composer can build stage-aware system prompts without re-reading
  // the file on every send. `null` = not yet loaded (or missing on disk);
  // callers should fall back to a generic prompt when null.
  const [manifest, setManifest] = useState<VentureManifest | null>(null);

  // Pending chat attachments. Each entry tracks extraction status so the
  // composer can render a spinner chip while docx is being parsed, then
  // flip to "ready" once the text is extracted. Cleared on venture switch
  // and after every successful send so the user doesn't accidentally
  // double-attach the same file in the next turn.
  const [chatAttachments, setChatAttachments] = useState<DashboardAttachment[]>([]);

  // Generate-reports state — true while the SaaS research reports step
  // is running. The button disables itself and shows a spinner label
  // while this is set. Kept separate from `isRunning` (which is for the
  // main build pipeline) so the two can't collide visually.
  const [reportsGenerating, setReportsGenerating] = useState(false);

  // Save-chat dropdown open/closed. Dropdown lives in the chat header;
  // outside-click closes it via the useEffect below (mirrors the Audit
  // tab Export menu pattern).
  const [chatExportMenuOpen, setChatExportMenuOpen] = useState(false);
  const chatExportMenuRef = useRef<HTMLDivElement | null>(null);

  // Derived: has the assistant signalled it's ready to generate? Drives
  // the button's pulsing glow + inline "ready" cue. Memoised because
  // scanning messages on every render would run on every token while a
  // stream is in flight (handleSend mutates the array per delta).
  const reportsCueActive = useMemo(() => assistantJustCuedReports(messages), [messages]);

  // Brand stage cues. Two tokens, two independent edge detectors —
  // emitting one doesn't imply the other. Same memoisation rationale:
  // scanning on every streamed delta would be wasted work.
  const brandNamingCueActive = useMemo(
    () => lastAssistantIncludes(messages, BRAND_NAMING_CUE),
    [messages]
  );
  const brandDirectionCueActive = useMemo(
    () => lastAssistantIncludes(messages, BRAND_DIRECTION_CUE),
    [messages]
  );
  // pt.34a — UK Setup cue. Same last-assistant-only scan + one-shot toast
  // pattern as the brand cues. Edge-detector ref reset on venture switch.
  const ukSetupCueActive = useMemo(() => lastAssistantIncludes(messages, UK_SETUP_CUE), [messages]);
  // pt.41g — Spec stage cue. Same shape.
  const specCueActive = useMemo(() => lastAssistantIncludes(messages, SPEC_CUE), [messages]);
  // pt.45 — Screens (a.k.a. WIREFRAME_READY) stage cue. Same shape.
  // Token matches the legacy stage enum value, see WIREFRAME_CUE.
  const wireframeCueActive = useMemo(
    () => lastAssistantIncludes(messages, WIREFRAME_CUE),
    [messages]
  );
  // Fire a one-shot toast the moment the cue first appears, so a user
  // with the Chat tab not focused still gets a nudge. We track the
  // previous value in a ref — firing on every truthy render would
  // re-push a toast on every incoming token while streaming (dedupe in
  // the toast store would coalesce but we'd still be spamming push).
  const prevCueRef = useRef(false);
  useEffect(() => {
    const prev = prevCueRef.current;
    prevCueRef.current = reportsCueActive;
    if (!prev && reportsCueActive && !reportsGenerating) {
      pushToast({
        kind: "info",
        message: "Research intake complete",
        detail:
          "The assistant thinks it has enough to draft the Core 4. Click ✨ Generate Reports when you're ready.",
        ttlMs: 6000,
      });
    }
  }, [reportsCueActive, reportsGenerating]);

  // Edge detectors for the two brand cues — one-shot toasts that nudge
  // the founder back to the Brand tab when the assistant signals
  // readiness. Separate refs so the two cues don't interfere with each
  // other (emitting naming, then direction, fires both toasts once).
  const prevBrandNamingCueRef = useRef(false);
  useEffect(() => {
    const prev = prevBrandNamingCueRef.current;
    prevBrandNamingCueRef.current = brandNamingCueActive;
    if (!prev && brandNamingCueActive) {
      pushToast({
        kind: "info",
        message: "Name candidates ready",
        detail: "Open the Brand tab to import them and run availability checks.",
        ttlMs: 6000,
      });
    }
  }, [brandNamingCueActive]);

  const prevBrandDirectionCueRef = useRef(false);
  useEffect(() => {
    const prev = prevBrandDirectionCueRef.current;
    prevBrandDirectionCueRef.current = brandDirectionCueActive;
    if (!prev && brandDirectionCueActive) {
      pushToast({
        kind: "info",
        message: "Brand direction ready",
        detail: "Open the Brand tab and hit Save Brief.",
        ttlMs: 6000,
      });
    }
  }, [brandDirectionCueActive]);

  // pt.34a — UK Setup cue edge detector. Fires once on the false→true
  // transition so a chat-tab-not-focused user still gets the nudge.
  const prevUkSetupCueRef = useRef(false);
  useEffect(() => {
    const prev = prevUkSetupCueRef.current;
    prevUkSetupCueRef.current = ukSetupCueActive;
    if (!prev && ukSetupCueActive) {
      pushToast({
        kind: "info",
        message: "UK setup looking complete",
        detail: "Open the UK Setup tab to confirm the must-haves and advance to Spec.",
        ttlMs: 6000,
      });
    }
  }, [ukSetupCueActive]);

  // pt.41g — Spec cue edge detector. Same pattern.
  const prevSpecCueRef = useRef(false);
  useEffect(() => {
    const prev = prevSpecCueRef.current;
    prevSpecCueRef.current = specCueActive;
    if (!prev && specCueActive) {
      pushToast({
        kind: "info",
        message: "Spec covers the must-haves",
        detail: "Open the Spec tab to confirm and advance to Wireframe.",
        ttlMs: 6000,
      });
    }
  }, [specCueActive]);

  // pt.45 — Screens cue edge detector. Same one-shot toast pattern.
  // Wording deliberately says "Screens" not "Wireframe" — the user
  // never sees the legacy stage label.
  const prevWireframeCueRef = useRef(false);
  useEffect(() => {
    const prev = prevWireframeCueRef.current;
    prevWireframeCueRef.current = wireframeCueActive;
    if (!prev && wireframeCueActive) {
      pushToast({
        kind: "info",
        message: "Screens cover the must-haves",
        detail: "Open the Screens tab to confirm and advance to Stitch.",
        ttlMs: 6000,
      });
    }
  }, [wireframeCueActive]);

  const venture = activeVenture();

  const handleOpenInFinder = async () => {
    if (!venture) return;
    try {
      await openInFileManager(venture.rootPath);
    } catch (err) {
      console.error("[fs] open_path failed", err);
      const msg = err instanceof Error ? err.message : String(err);
      // Sticky toast + banner. The banner is per-venture so it vanishes
      // on switch, the toast survives — a user who toggles between
      // ventures still sees the failure until they X it.
      pushToast({
        kind: "error",
        message: "Couldn't open venture folder",
        detail: msg,
      });
      setError(msg);
    }
  };

  const handleConfirmDelete = async () => {
    if (!venture || deleting) return;
    setDeleting(true);
    try {
      // DB first — if the row survives but the folder is gone, the user
      // sees a ghost venture on next load. Clearing the row first means
      // a disk-delete failure leaves the user without their DB record but
      // with the folder intact, which is recoverable by re-importing.
      await db.deleteVenture(venture.id);
      if (deleteFromDisk) {
        await deleteVentureDir(venture.rootPath);
      }
      removeVenture(venture.id);
      setDeleteConfirmOpen(false);
      setDeleteFromDisk(false);
    } catch (err) {
      console.error("[db/fs] deleteVenture failed", err);
      const msg = err instanceof Error ? err.message : String(err);
      // Sticky toast — deletion is destructive and partial failure can
      // leave the user with a ghost state (e.g. DB cleared but disk
      // intact). Surface loudly.
      pushToast({
        kind: "error",
        message: "Couldn't delete venture",
        detail: msg,
      });
      setError(msg);
    } finally {
      setDeleting(false);
    }
  };

  // Clear any stale error from a previous venture when switching.
  // Errors live in the global store, so a failed Open in Finder on
  // venture A would otherwise still show on venture B's dashboard.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally omitted
  useEffect(() => {
    setError(null);
  }, [venture?.id, setError]);

  // Reload chat thread whenever venture or stage changes.
  // Keyed on `${id}:${stage}` so switching stages swaps threads.
  // A ref tracks the latest requested key so out-of-order responses
  // from a slow DB don't overwrite a newer thread.
  const latestThreadKey = useRef<string>("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally omitted
  useEffect(() => {
    if (!venture) {
      setMessages([]);
      return;
    }
    const key = `${venture.id}:${venture.stage}`;
    latestThreadKey.current = key;
    setChatHydrating(true);
    db.listChatMessages(venture.id, venture.stage)
      .then((rows) => {
        if (latestThreadKey.current !== key) return;
        setMessages(rows);
      })
      .catch((err) => {
        console.error("[db] listChatMessages failed", err);
        const msg = err instanceof Error ? err.message : String(err);
        // Error-level — the chat thread is the main venture surface;
        // a hydration failure means the user sees an empty chat and
        // thinks their history is gone. Sticky until acknowledged.
        pushToast({
          kind: "error",
          message: "Couldn't load chat history",
          detail: msg,
        });
        setError(msg);
      })
      .finally(() => {
        if (latestThreadKey.current === key) setChatHydrating(false);
      });
  }, [venture?.id, venture?.stage, setError]);

  // Clear pending attachments whenever the venture switches — they're
  // scoped to the current composer session, not the app.
  // Default to the stage-specific guided tab when switching ventures so the
  // walkthrough is the first thing the founder sees.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally omitted
  useEffect(() => {
    setChatAttachments([]);
    setPromptMasterTokensSaved(0);
    prevCueRef.current = false;
    prevBrandNamingCueRef.current = false;
    prevBrandDirectionCueRef.current = false;
    prevUkSetupCueRef.current = false;
    prevSpecCueRef.current = false;
    prevWireframeCueRef.current = false;
    if (venture?.stage === "IDEA") {
      setTab("idea");
    } else if (venture?.stage === "RESEARCHED") {
      setTab("research");
    } else if (venture?.stage === "VALIDATED") {
      // VALIDATED lands straight in Brand — that's the next guided stage.
      // ValidationTab is still reachable via the tab bar for review/edits.
      setTab("brand");
    } else if (venture?.stage === "BRAND_READY") {
      setTab("brand");
    } else if (venture?.stage === "UK_SETUP_READY") {
      // pt.34a — re-opening a venture already at UK_SETUP_READY lands in
      // the UK Setup tab so the founder picks up where they left off.
      // Stage-advance from BRAND_READY already routes here via STAGE_TAB.
      setTab("uk-setup");
    } else if (venture?.stage === "SPEC_READY") {
      // pt.41 — same routing rationale as UK_SETUP_READY. Re-opening
      // lands on the Spec tab; stage-advance from UK_SETUP_READY
      // already routes here via STAGE_TAB.
      setTab("spec");
    } else if (venture?.stage === "WIREFRAME_READY") {
      // pt.45 — re-opening at WIREFRAME_READY lands in the Screens tab
      // (legacy stage name, user-facing label is "Screens"). Stage-
      // advance from SPEC_READY also routes here via STAGE_TAB.
      setTab("screens");
    } else {
      setTab("overview");
    }
  }, [venture?.id]);

  // Hydrate the venture.yaml manifest on venture switch. Cached locally so
  // handleSend can compose stage-aware system prompts (baseSystemPrompt
  // needs the full manifest — entityType, regulated flags, etc.) without
  // re-reading YAML on every keypress. A missing manifest isn't fatal:
  // handleSend falls back to a generic prompt when this is null.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally omitted
  useEffect(() => {
    if (!venture) {
      setManifest(null);
      return;
    }
    let cancelled = false;
    loadVentureManifest(venture.rootPath)
      .then((m) => {
        if (cancelled) return;
        setManifest(m ?? null);
      })
      .catch((err) => {
        // Non-fatal — we fall back to the generic prompt. Log but don't
        // spam the user with an error banner for a missing/corrupt YAML.
        if (cancelled) return;
        console.warn("[dashboard] loadVentureManifest failed", err);
        setManifest(null);
      });
    return () => {
      cancelled = true;
    };
  }, [venture?.id, venture?.rootPath]);

  const handleRunPipeline = async () => {
    if (!venture || isRunning) return;

    // Load the full manifest from venture.yaml. The Venture row in the DB
    // is a subset (no entityType / regulated / etc.) so we need the on-disk
    // manifest the wizard wrote. Fall back to a minimal manifest if it's
    // missing — better to run with defaults than refuse.
    //
    // The fallback is validated via VentureManifestSchema.safeParse so a
    // future typo (e.g. `appType: "web_app"` when the enum is `"web"`) is
    // caught here instead of silently riding through downstream steps that
    // equality-check against the canonical enum values. Caught us once
    // already — pt.14 deferral fix.
    let manifest = await loadVentureManifest(venture.rootPath);
    if (!manifest) {
      console.warn("[pipeline] no venture.yaml found, using minimal manifest");
      const fallback: VentureManifest = {
        id: venture.id,
        name: venture.name,
        slug: venture.slug,
        entityType: "sole_trader",
        appType: "web",
        regulated: false,
        takesPayments: false,
        handlesPersonalData: false,
        hiresStaff: false,
        currentStage: venture.stage,
        blockers: [],
      };
      const parsed = VentureManifestSchema.safeParse(fallback);
      if (!parsed.success) {
        // Construction-time bug — surface loudly so dev sees it on first run.
        const issue = parsed.error.issues[0];
        const msg = `Internal: minimal manifest fallback is invalid — ${issue?.path.join(".") ?? "?"}: ${issue?.message ?? "unknown"}`;
        console.error("[pipeline]", msg, parsed.error);
        pushToast({ kind: "error", message: "Couldn't start pipeline", detail: msg });
        setError(msg);
        return;
      }
      manifest = parsed.data;
    }

    setTab("pipeline");
    const runId = crypto.randomUUID();

    try {
      await db.insertRun({ runId, ventureId: venture.id, type: "build_pipeline" });
    } catch (err) {
      console.error("[db] insertRun failed", err);
      const msg = err instanceof Error ? err.message : String(err);
      // Pipeline-run failures at this stage mean we never actually started
      // — surface as an error toast so the user sees why the "Run" click
      // did nothing. Dedupe collapses double-clicks to a single toast.
      pushToast({
        kind: "error",
        message: "Couldn't start pipeline run",
        detail: msg,
      });
      setError(msg);
      return;
    }

    // pt.28 / pt.30a: fresh AbortController per run via the hook. The
    // signal flows down through `buildPipelineLlmCaller` into every
    // `streamChat` invoked by the brand LLM steps, AND (pt.30c) into
    // the orchestrator itself which checks it between steps.
    //
    // The hook's `begin()` can't throw, so it lives outside the try.
    // Everything that *could* throw (provider resolution, runPipeline)
    // goes inside, and the finally calls `clear()` unconditionally.
    const pipelineController = pipelineTask.begin();

    try {
      // Resolve a pipeline LLM caller (pt.27) so the orchestrator can run
      // the brand LLM steps inline. If no provider is configured,
      // `buildPipelineLlmCaller` returns null — we pass `callLlm: undefined`
      // and the orchestrator marks both LLM steps `skipped` automatically.
      // Deterministic steps still run, so the pipeline remains useful even
      // without an API key. We also surface a one-shot info toast on the
      // skip path so the user knows why brand steps were quiet.
      const llmCaller = await buildPipelineLlmCaller({
        ventureId: venture.id,
        signal: pipelineController.signal,
      });
      if (!llmCaller) {
        pushToast({
          kind: "info",
          message: "Brand LLM steps skipped",
          detail:
            "No AI provider configured. Open the Options tab to add a key — naming candidates and logo concepts will then run as part of the pipeline.",
          ttlMs: 6000,
        });
      }

      const result = await runPipeline({
        manifest,
        ventureRoot: venture.rootPath,
        runId,
        fs: tauriFs,
        // Pass the DB venture stage explicitly (pt.19) — the on-disk
        // manifest can lag because handleStageChange only updates the DB
        // row, not venture.yaml. The audit step uses this to filter
        // rules whose minStage is ahead of where the venture actually is.
        ventureStage: venture.stage,
        // pt.27: when a provider is configured, the orchestrator runs
        // `generate-naming-candidates` + `generate-logo-concepts` in
        // their natural slots. Both steps already skip-if-exists for
        // logo concepts and dedup on naming, so re-running the pipeline
        // is cheap (zero extra LLM calls if artifacts are already there).
        callLlm: llmCaller?.callLlm,
        // pt.30c: same controller signal threaded into the orchestrator
        // itself. The orchestrator checks `signal.aborted` between
        // steps and bails. Combined with the per-LLM-call signal in
        // `callLlm`, a single abort cancels both in-flight LLM work
        // and any subsequent deterministic steps.
        signal: pipelineController.signal,
        onProgress: (plan) => {
          // First progress event sets the active plan; later events update it.
          // The store handles both via setActivePlan + updateActivePlan, but
          // setActivePlan also flips isRunning, so call it once on the first
          // event and updateActivePlan thereafter.
          if (!usePipelineStore.getState().activePlan) {
            setActivePlan(plan);
          } else {
            updateActivePlan(plan);
          }
        },
      });

      // pt.28: discriminate cancel-vs-failure-vs-success via the signal.
      // The orchestrator's internal catch SWALLOWS thrown errors and
      // returns `{success: false, error}` rather than re-throwing, so
      // an AbortError mid-pipeline doesn't reach our outer `catch (err)`.
      // The signal is the only reliable cancel discriminator. Bonus
      // edge case: if cancel landed during logo-concepts the step can
      // return "partial" (some concepts wrote before the abort), the
      // orchestrator continues from "partial" to deterministic steps,
      // and the run can technically finish with `success: true` — the
      // signal check catches that path too.
      const cancelled = pipelineController.signal.aborted;
      const summary = `${result.plan.steps.filter((s) => s.status === "done").length}/${result.plan.steps.length} steps done`;

      if (cancelled) {
        console.info("[pipeline] cancelled by user", {
          resultSuccess: result.success,
          summary,
        });
        pushToast({
          kind: "info",
          message: "Pipeline AI calls stopped",
          detail: result.success
            ? "Deterministic steps finished. AI artifacts may be partial."
            : "Run was halted before completion.",
          ttlMs: 5000,
        });
        // pt.30b: distinct "cancelled" status — UI renders it with
        // neutral chrome (vs failure red). The error field is left
        // null because "cancelled" is the discriminator; no need to
        // duplicate the meaning into a free-text field.
        await db.updateRunStatus(runId, "cancelled", { summary });
      } else {
        await db.updateRunStatus(runId, result.success ? "succeeded" : "failed", {
          summary,
          error: result.error,
        });
      }

      // Persist audit findings. Always attempt this — a failed run can still
      // have partial findings from earlier steps that ran OK. Writing them
      // behind the run-status update means the row exists before the FK-ish
      // lookup in the Audit tab joins the two.
      if (result.findings && result.findings.length > 0) {
        try {
          await db.insertAuditFindings({
            runId,
            ventureId: venture.id,
            findings: result.findings.map((f) => ({
              ruleId: f.ruleId,
              severity: f.severity,
              title: f.title,
              message: f.message,
              filePath: f.evidence[0]?.filePath,
            })),
          });
        } catch (err) {
          // Non-fatal — findings are nice-to-have, don't nuke the whole run.
          console.error("[db] insertAuditFindings failed", err);
          // Warn (not error) — the pipeline itself succeeded, only the
          // audit persistence side-car broke. Audit tab will look empty
          // for this run, so the user should know why without it being
          // presented as a fatal.
          pushToast({
            kind: "warn",
            message: "Audit findings couldn't be saved",
            detail: err instanceof Error ? err.message : String(err),
            ttlMs: 6000,
          });
        }
      }
    } catch (err) {
      // pt.28 / pt.30a: cancel-vs-failure discrimination via the hook.
      // The successful-runPipeline-with-aborted-signal path is handled
      // above (in the try block); this catch only fires when something
      // *threw* to bypass the result-processing code.
      const isAbort = pipelineTask.wasCancelled(pipelineController, err);
      const msg = err instanceof Error ? err.message : String(err);
      if (isAbort) {
        console.info("[pipeline] cancelled by user");
        pushToast({
          kind: "info",
          message: "Pipeline cancelled",
          detail: "In-flight LLM calls were aborted.",
          ttlMs: 4000,
        });
        try {
          // pt.30b: distinct "cancelled" status — see notes in the
          // success-path branch above.
          await db.updateRunStatus(runId, "cancelled", {});
        } catch {
          /* swallow */
        }
      } else {
        console.error("[pipeline] run failed", err);
        // Sticky error toast — a broken pipeline run is the single most
        // disruptive failure in the app. Banner + toast together so it's
        // visible even if the user flips tabs mid-run.
        pushToast({
          kind: "error",
          message: "Pipeline run failed",
          detail: msg,
        });
        setError(msg);
        try {
          await db.updateRunStatus(runId, "failed", { error: msg });
        } catch {
          /* swallow — original error already surfaced */
        }
      }
    } finally {
      // Plan stays in activePlan so the Pipeline tab keeps rendering it
      // (acts as "last run" view); just flip the running flag off.
      setRunning(false);
      // pt.30a: hook clears the controller ref + stopping flag.
      pipelineTask.clear();
      // Files were just written to disk — nudge the Artifacts tab so the
      // user sees the new files the moment they switch over.
      setArtifactsRescanToken((n) => n + 1);
      // Same nudge for the Audit tab, so findings light up when the user
      // flips over to it.
      setAuditRefreshToken((n) => n + 1);
    }
  };

  // Maps a pipeline stage to the guided tab that should be shown immediately
  // after advancing into that stage. Stages not listed here fall through to
  // "overview" (the default for later pipeline stages where we don't yet have
  // a dedicated guided tab).
  const STAGE_TAB: Partial<Record<VentureStage, Tab>> = {
    IDEA: "idea",
    RESEARCHED: "research",
    VALIDATED: "brand",
    BRAND_READY: "brand",
    // pt.33: advancing to UK_SETUP_READY drops the founder straight
    // into the UK Setup workshop tab so the next batch of decisions
    // (entity, HMRC, banking, insurance, IP) is the first thing they see.
    UK_SETUP_READY: "uk-setup",
    // pt.41: SPEC_READY → spec canvas. Same routing pattern as UK
    // Setup — the structured spec tab is the first thing the founder
    // sees on stage advance, with the chat overlay coaching alongside.
    SPEC_READY: "spec",
    // pt.45: WIREFRAME_READY (legacy enum) → "screens" tab (user-
    // facing label). Same routing pattern; the screen inventory is
    // the first thing the founder sees on stage advance.
    WIREFRAME_READY: "screens",
  };

  const handleStageChange = async (nextStage: VentureStage) => {
    if (!venture || venture.stage === nextStage || stageSaving) return;
    setStageSaving(true);
    try {
      // Persist first — if DB fails we never touch the in-memory store,
      // so the badge/graph remain truthful.
      await db.updateVentureStage(venture.id, nextStage);
      updateVentureStage(venture.id, nextStage);
      // Switch to the guided tab for the new stage, or overview for later stages.
      setTab(STAGE_TAB[nextStage] ?? "overview");
    } catch (err) {
      console.error("[db] updateVentureStage failed", err);
      const msg = err instanceof Error ? err.message : String(err);
      // Sticky error toast — stage advancement is a deliberate action
      // (user clicked a specific stage in the graph); if it silently
      // failed they'd be confused when later runs don't pick up the new
      // stage. Banner would clear on next venture switch, toast won't.
      pushToast({
        kind: "error",
        message: "Couldn't save stage change",
        detail: msg,
      });
      setError(msg);
    } finally {
      setStageSaving(false);
    }
  };

  // Called by IdeaTab when it writes an updated manifest to disk.
  // Keeps the in-memory manifest cache in sync so chat system prompts
  // reflect the latest entityType / regulated / takesPayments flags
  // without requiring a full reload.
  const handleManifestUpdate = (updated: VentureManifest) => {
    setManifest(updated);
  };

  if (!venture) {
    return <div style={{ padding: 40, color: "#6B7280" }}>Venture not found.</div>;
  }

  const handleSend = async (content: string) => {
    if (!venture) return;

    // Fold any ready attachments into the outgoing message. Extraction
    // errors and still-pending chips are filtered out — the composer
    // already disables Send while anything's pending, but we belt-and-
    // braces here too in case the user force-sends via keyboard.
    const readyAttachments = chatAttachments.filter(
      (a) => a.status === "ready" && typeof a.text === "string"
    );
    const attachmentBlock = buildAttachmentBlock(
      // biome-ignore lint/style/noNonNullAssertion: value asserted non-null by surrounding logic
      readyAttachments.map((a) => ({ name: a.name, text: a.text! }))
    );
    // Compose the user-visible message: attachment block first, then the
    // typed content. Persisted as one row so re-hydrating the thread on
    // reload shows the same bubble the user saw.
    const composedContent = attachmentBlock
      ? content
        ? `${attachmentBlock}\n\n${content}`
        : attachmentBlock
      : content;

    const userMsg: ChatMessage = {
      id: makeMsgId(),
      role: "user",
      content: composedContent,
      createdAt: new Date().toISOString(),
    };
    // Optimistic: render immediately, persist in the background.
    setMessages((prev) => [...prev, userMsg]);
    setChatLoading(true);
    // Clear attachments as soon as the send is under way — they belong
    // to the message we're about to fire, and leaving them visible would
    // imply they're still queued for the next turn.
    if (readyAttachments.length > 0) {
      setChatAttachments((prev) =>
        prev.filter((a) => !readyAttachments.some((r) => r.id === a.id))
      );
    }

    try {
      await db.insertChatMessage(venture.id, venture.stage, userMsg);
    } catch (err) {
      console.error("[db] insertChatMessage (user) failed", err);
      const msg = err instanceof Error ? err.message : String(err);
      // Sticky error toast — the user's message got rolled back and the
      // LLM call is aborted. Without the toast the user just sees their
      // typed message vanish from the thread (optimistic add, then
      // pulled) with no explanation.
      pushToast({
        kind: "error",
        message: "Couldn't save your message",
        detail: msg,
      });
      setError(msg);
      // Roll back the optimistic add so the UI matches truth.
      setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
      setChatLoading(false);
      return;
    }

    // Resolve which LLM to call. Pass the venture id so a per-venture
    // override (ventures.default_provider) wins over the global active
    // provider. If nothing's configured yet, drop the user into the Options
    // tab with a helpful error instead of silently failing.
    const providerId = await pickActiveProvider(venture.id);
    if (!providerId) {
      setError("No AI provider configured. Open the Options tab to paste an API key.");
      setChatLoading(false);
      setTab("options");
      return;
    }

    // Pull the saved setting so we can tag the assistant bubble with the
    // transport (api_key vs subscription) alongside the provider id. This
    // drives the "via Claude · PRO" / "via ChatGPT · API" caption in the
    // chat bubble. Reads cheap — just the one row we're about to use.
    const activeSetting = await db.getLlmSetting(providerId);
    const providerMode = activeSetting?.mode === "subscription" ? "subscription" : "api_key";

    // Seed an empty assistant bubble we'll progressively fill with streaming
    // deltas. Using a stable id means the bubble stays in place as tokens
    // arrive — no flicker from React reconciling new list items. Tag it
    // with provider metadata up front so the "via …" caption appears as
    // soon as the first token lands, not only after persistence.
    const assistantId = makeMsgId();
    const assistantCreatedAt = new Date().toISOString();
    setMessages((prev) => [
      ...prev,
      {
        id: assistantId,
        role: "assistant",
        content: "",
        createdAt: assistantCreatedAt,
        provider: providerId,
        providerMode,
      },
    ]);

    // Build the provider-agnostic message array. We include the current
    // in-flight user message (the optimistic state above may not have
    // flushed to DB round-trip yet, but we have it in local scope). We
    // deliberately exclude any previous `welcome`-id placeholder that only
    // exists when the thread is empty, since it's not persisted.
    const historyForProvider = [...messages.filter((m) => m.id !== "welcome"), userMsg].map(
      (m) => ({
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
      })
    );

    // Stage-aware system prompt composition. When the full venture manifest
    // has been loaded (venture.yaml on disk), we stack:
    //   base  — who/what/where for this venture (entityType, regulated, etc.)
    //   stage — general guidance for the current stage
    //   intake — SaaS-specific discovery flow (only when stage=RESEARCHED
    //            AND appType=saas). Drives the Core 4 reports generator.
    // When the manifest hasn't hydrated yet we fall back to the old terse
    // coach prompt so the chat still works on first-paint; it'll pick up
    // the richer composition on the next send.
    const systemPrompt = buildSystemPromptForSend({
      ventureName: venture.name,
      ventureStage: venture.stage,
      manifest,
    });

    // Run the system prompt through Prompt Master before sending. By
    // contract optimize() never throws — when no transport is wired up
    // (or one fails) it returns the input unchanged with fallbackUsed=true,
    // so we don't try/catch here.
    const optimizedSystem = await optimize({
      prompt: systemPrompt,
      context: "venture-chat",
      ventureId: venture.id,
    });
    if (optimizedSystem.tokensSaved > 0) {
      setPromptMasterTokensSaved((prev) => prev + optimizedSystem.tokensSaved);
    }
    console.info(
      "[prompt-master] venture-chat",
      optimizedSystem.fallbackUsed
        ? "(fallback — transport unavailable)"
        : `tokensSaved=${optimizedSystem.tokensSaved} cacheHit=${optimizedSystem.cacheHit}`
    );

    // Fresh controller for this send. Abort any stray one first — shouldn't
    // happen (handleSend is gated by chatLoading on the UI side) but it's
    // cheap insurance against a stuck ref.
    if (chatAbortRef.current) {
      chatAbortRef.current.abort();
    }
    const controller = new AbortController();
    chatAbortRef.current = controller;

    // Turn web search on for research-stage conversations. The helper
    // checks provider capability too — non-Anthropic providers just see
    // the flag dropped on the floor by streamChat. We gate on stage
    // (not only appType) so web search also helps non-SaaS research
    // chats even if we don't auto-generate reports for them yet.
    const enableWebSearch = venture.stage === "RESEARCHED";

    let finalText = "";
    let cancelled = false;
    try {
      finalText = await streamChat({
        provider: providerId,
        system: optimizedSystem.optimized,
        messages: historyForProvider,
        signal: controller.signal,
        enableWebSearch,
        onDelta: (delta) => {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + delta } : m))
          );
        },
      });
    } catch (err) {
      // AbortError = user hit Stop. We keep the partial the model emitted
      // as the final content — it's an honest transcript of what happened,
      // and future turns benefit from the context. If nothing streamed in
      // before the cancel, we drop the empty bubble instead of persisting
      // a blank row.
      if ((err as { name?: string })?.name === "AbortError") {
        cancelled = true;
        finalText = (err as { partial?: string })?.partial ?? "";
      } else {
        console.error("[llm] streamChat failed", err);
        const msg = err instanceof Error ? err.message : String(err);
        const providerName = getProvider(providerId).displayName;
        // Sticky error toast — LLM provider errors are the most common
        // runtime failure (rate limits, bad keys, network). Banner +
        // toast both: the banner dies on venture switch, the toast
        // persists so the user can still see what went wrong.
        pushToast({
          kind: "error",
          message: `${providerName} error`,
          detail: msg,
        });
        setError(`${providerName}: ${msg}`);
        // Drop the empty/partial assistant bubble so the user isn't stuck
        // with a half-rendered reply.
        setMessages((prev) => prev.filter((m) => m.id !== assistantId));
        if (chatAbortRef.current === controller) {
          chatAbortRef.current = null;
        }
        setChatStopping(false);
        setChatLoading(false);
        return;
      }
    }

    // Clear the controller now that the stream has settled one way or the
    // other. Anything after this point is post-stream (persistence).
    if (chatAbortRef.current === controller) {
      chatAbortRef.current = null;
    }

    // Cancelled with zero streamed content — drop the empty bubble rather
    // than write a blank row. Common when the user hits Stop before the
    // first token arrives.
    if (cancelled && !finalText.trim()) {
      setMessages((prev) => prev.filter((m) => m.id !== assistantId));
      setChatStopping(false);
      setChatLoading(false);
      return;
    }

    // Normalize the bubble to exactly what we'll persist. On a cancel the
    // `llm-cancel` event's `text` (= err.partial) may be a few tokens ahead
    // of what onDelta managed to commit to state before abort landed — this
    // keeps the displayed bubble in sync with the DB row so a reload shows
    // the same content. Harmless on the normal done path (both match).
    if (cancelled) {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, content: finalText } : m))
      );
    }

    // Persist the fully-streamed reply. We do this after the stream closes
    // rather than mid-stream so we don't rewrite the same row 50 times.
    // Provider + mode are snapshot at send time so history stays accurate
    // even if the user flips providers between now and the next reload.
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: finalText,
      createdAt: assistantCreatedAt,
      provider: providerId,
      providerMode,
    };
    try {
      await db.insertChatMessage(venture.id, venture.stage, assistantMsg);
    } catch (err) {
      console.error("[db] insertChatMessage (assistant) failed", err);
      const msg = err instanceof Error ? err.message : String(err);
      // Warn (not error) — the reply is visible on screen, only DB
      // persistence failed. The user's LLM call already cost tokens, so
      // let them know the transcript won't survive reload while they
      // can still copy/save it. "Save Chat" from pt.18 is the escape
      // hatch if they want to keep the reply.
      pushToast({
        kind: "warn",
        message: "Reply shown but not saved to history",
        detail: `${msg} — use Save Chat to keep it before reloading.`,
        ttlMs: 8000,
      });
      setError(msg);
      // Leave the message in the UI — the user saw a real reply, better to
      // keep it visible than erase useful output over a DB hiccup.
    } finally {
      // Stream has settled one way or the other (finalText persisted) —
      // drop both spinners together. Safe to clear chatStopping even on
      // the non-cancelled path: we only set it via handleCancelChat, so
      // this is either a no-op or the terminal transition.
      setChatStopping(false);
      setChatLoading(false);
    }
  };

  // Accept a FileList from the chat composer's paperclip button. Each
  // file is added to state immediately as a "pending" chip, then extracted
  // in parallel — the chip flips to "ready" or "error" as promises settle.
  // This lets the user see progress for large .docx files instead of
  // watching a frozen UI while mammoth parses.
  const handleAttach = async (files: FileList) => {
    const newChips: DashboardAttachment[] = Array.from(files).map((f) => ({
      id: makeMsgId(),
      name: f.name,
      size: f.size,
      status: "pending",
    }));
    setChatAttachments((prev) => [...prev, ...newChips]);

    // Kick off extractions in parallel. We keep the File objects locally
    // (not in state — they're not serialisable and we don't need them
    // after extraction).
    await Promise.all(
      newChips.map(async (chip, idx) => {
        const file = files[idx];
        const result = await extractAttachment(file);
        setChatAttachments((prev) =>
          prev.map((c) => {
            if (c.id !== chip.id) return c;
            if (result.kind === "ok") {
              return { ...c, status: "ready", text: result.text };
            }
            return { ...c, status: "error", error: result.error };
          })
        );
        if (result.kind === "error") {
          // Surface extraction failures as a toast too — the chip's
          // small hover-tooltip is easy to miss, especially for PDFs
          // where the user is actively waiting for something to happen.
          pushToast({
            kind: "warn",
            message: `Couldn't attach "${chip.name}"`,
            detail: result.error,
            ttlMs: 6000,
          });
        }
      })
    );
  };

  const handleRemoveAttachment = (id: string) => {
    setChatAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  /**
   * Kick off the "Core 4" SaaS research reports generator. Invoked from
   * the chat-header button visible on stage=RESEARCHED + appType=saas.
   *
   * Flow:
   *  1. Verify prerequisites (manifest loaded, provider configured).
   *  2. Build the intake transcript from the current chat thread + any
   *     ready attachments.
   *  3. Hand off to runResearchStage(), which wraps the underlying
   *     createSaasResearchReportsStep with the stage-runner contract:
   *     preflight validation, idempotency, failed-runs index, stage-
   *     progress advancement, artifact index entries.
   *  4. Surface outcome via toast + optional assistant-bubble summary in
   *     the chat so the founder has a receipt of what was written.
   */
  const handleGenerateResearchReports = async () => {
    if (!venture || reportsGenerating) return;

    if (!manifest) {
      pushToast({
        kind: "warn",
        message: "Venture manifest hasn't loaded yet — try again in a moment",
        ttlMs: 5000,
      });
      return;
    }
    if (manifest.appType !== "saas") {
      pushToast({
        kind: "warn",
        message: "Generate Reports is only available for SaaS ventures",
        ttlMs: 5000,
      });
      return;
    }

    // pt.29 / pt.30a: fresh AbortController via the hook. Wired through
    // `buildPipelineLlmCaller` so a single `controller.abort()` cancels
    // all 4 parallel report calls simultaneously (they share this
    // signal via closure capture inside the helper).
    const reportsController = reportsTask.begin();

    setReportsGenerating(true);
    pushToast({
      kind: "info",
      message: "Generating Core 4 research reports…",
      detail: "Running 4 LLM calls in parallel. This usually takes 30-60s.",
      ttlMs: 4000,
    });

    try {
      // Build intake from the chat transcript + any still-ready
      // attachments the founder hasn't sent yet. Assistant turns are
      // included so the model sees the back-and-forth (clarifying
      // questions + answers) not just raw user messages.
      const transcriptLines: string[] = [];
      for (const m of messages) {
        if (m.id === "welcome") continue;
        const who =
          m.role === "assistant" ? "Assistant" : m.role === "system" ? "System" : "Founder";
        transcriptLines.push(`## ${who}\n${m.content.trim()}`);
      }
      const readyAttachments = chatAttachments.filter(
        (a) => a.status === "ready" && typeof a.text === "string"
      );
      const attachmentBlock = buildAttachmentBlock(
        // biome-ignore lint/style/noNonNullAssertion: value asserted non-null by surrounding logic
        readyAttachments.map((a) => ({ name: a.name, text: a.text! }))
      );
      const intake = [transcriptLines.join("\n\n"), attachmentBlock].filter(Boolean).join("\n\n");

      // Adopt @founder-os/stage-runners. Wraps the same
      // createSaasResearchReportsStep we used to call directly with
      // preflight validation, idempotency, failed-runs bookkeeping,
      // and stage-progress advancement. force=true (helper default)
      // preserves "regenerate on every click" -- the underlying step
      // is itself file-level idempotent so the LLM cost is bounded.
      const out = await runResearchStage({
        venture,
        manifest,
        intake,
        signal: reportsController.signal,
      });
      if (out.kind === "no-provider") {
        pushToast({
          kind: "warn",
          message: "No AI provider configured",
          detail: "Open the Options tab to paste an API key.",
          ttlMs: 6000,
        });
        setTab("options");
        return;
      }
      const { result, counts } = out;

      // pt.29: signal-aborted check, parallel to the pt.28 pipeline path.
      // The step's per-task try/catch converts AbortError into per-report
      // `failed` outcomes inside result.logs, so the runner can still
      // report success=true with a partial set even when the user hit
      // Stop. Treat that as a cancel (info toast, no error chrome).
      const cancelled = reportsController.signal.aborted;

      if (cancelled) {
        console.info("[reports] cancelled by user", {
          success: result.success,
          ...counts,
        });
        pushToast({
          kind: "info",
          message: "Reports generation stopped",
          detail:
            counts.written > 0
              ? `${counts.written} written before cancel -- partial set under 01_research/saas/.`
              : "No reports completed before cancel.",
          ttlMs: 5000,
        });
        if (counts.written > 0) {
          // Nudge the Artifacts tab so partial output shows up.
          setArtifactsRescanToken((n) => n + 1);
        }
      } else if (result.success) {
        const bits: string[] = [];
        if (counts.written) bits.push(`${counts.written} written`);
        if (counts.skipped) bits.push(`${counts.skipped} skipped (already existed)`);
        if (counts.failed) bits.push(`${counts.failed} failed`);
        pushToast({
          kind: counts.failed > 0 ? "warn" : "success",
          message: bits.length ? `Reports: ${bits.join(", ")}` : "Reports stage complete",
          detail: "Saved under 01_research/saas/ -- open the Artifacts tab to view.",
          ttlMs: 8000,
        });
        // Nudge the Artifacts tab so new files show up immediately if
        // the user clicks over.
        setArtifactsRescanToken((n) => n + 1);
      } else {
        pushToast({
          kind: "error",
          message: "All 4 reports failed to generate",
          detail: result.error?.message,
        });
      }
    } catch (err) {
      // pt.29 / pt.30a: cancel-vs-failure discrimination via the hook.
      const isAbort = reportsTask.wasCancelled(reportsController, err);
      if (isAbort) {
        console.info("[reports] cancelled by user");
        pushToast({
          kind: "info",
          message: "Reports generation cancelled",
          detail: "In-flight LLM calls were aborted.",
          ttlMs: 4000,
        });
      } else {
        console.error("[reports] generate failed", err);
        pushToast({
          kind: "error",
          message: "Couldn't generate research reports",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      // pt.30a: hook clears controller + stopping flag. Always run
      // even if we returned early (e.g. no provider configured).
      reportsTask.clear();
      setReportsGenerating(false);
    }
  };

  const handleCancelChat = () => {
    // Guard against double-clicks — once we've kicked off the abort, the
    // button is disabled but belt-and-braces against a stale handler firing.
    if (!chatAbortRef.current || chatStopping) return;
    // Flip the optimistic flag FIRST so the button re-renders as
    // "Stopping…" / disabled without waiting for the Rust cancel to land.
    // The flag clears on the natural settle path (finally / error / empty
    // partial branch) — we don't need a timeout because the cancel always
    // resolves within a few hundred ms via llm-cancel.
    setChatStopping(true);
    // Abort the live controller. `streamChat` catches the signal, fires
    // `llm_cancel` on the Rust side, and rejects with AbortError — the
    // catch block in handleSend then keeps the partial as the final text.
    chatAbortRef.current.abort();
  };

  const handleClearChat = async () => {
    if (!venture) return;
    try {
      await db.clearChatThread(venture.id, venture.stage);
      setMessages([]);
    } catch (err) {
      console.error("[db] clearChatThread failed", err);
      const msg = err instanceof Error ? err.message : String(err);
      // Sticky error toast — "Clear thread" is a deliberate destructive
      // action, and silent failure here means the user reloads and is
      // confused when the thread reappears.
      pushToast({
        kind: "error",
        message: "Couldn't clear chat thread",
        detail: msg,
      });
      setError(msg);
    }
  };

  // --- Save Chat ---------------------------------------------------------
  //
  // Export the current (ventureId, stage) thread as Markdown so the founder
  // can keep it as memory, paste it into another LLM, or archive it with
  // the venture workspace. Two affordances — Copy (clipboard) and Save
  // (native file dialog + Rust write_file). Both use the same serializer.

  const handleCopyChatMarkdown = async () => {
    if (!venture) return;
    // Guard: no messages = nothing to export. Button is disabled in this
    // state but a keyboard path could still get here.
    if (messages.length === 0) {
      pushToast({ kind: "warn", message: "Nothing to copy — this thread is empty." });
      return;
    }
    try {
      const text = buildChatMarkdown({
        ventureName: venture.name,
        stage: venture.stage,
        messages,
        exportedAt: new Date(),
      });
      await navigator.clipboard.writeText(text);
      pushToast({
        kind: "success",
        message: `Copied chat as Markdown · ${messages.length} message${
          messages.length === 1 ? "" : "s"
        }`,
      });
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Couldn't copy chat to clipboard",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setChatExportMenuOpen(false);
    }
  };

  const handleSaveChatMarkdown = async () => {
    if (!venture) return;
    if (messages.length === 0) {
      pushToast({ kind: "warn", message: "Nothing to save — this thread is empty." });
      return;
    }
    try {
      const now = new Date();
      const text = buildChatMarkdown({
        ventureName: venture.name,
        stage: venture.stage,
        messages,
        exportedAt: now,
      });
      const defaultPath = defaultChatExportFilename(venture.id, venture.stage, now);
      // Native Save dialog — null return = user cancelled, treat as a
      // silent no-op (not an error).
      const filePath = await saveFileDialog({
        defaultPath,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!filePath) {
        setChatExportMenuOpen(false);
        return;
      }
      // Reuse the existing Rust write_file command — same one the Audit
      // export + artifact writes use, so error shape and path handling
      // are consistent across the app.
      await invoke("write_file", { path: filePath, content: text });
      pushToast({
        kind: "success",
        message: `Saved chat · ${messages.length} message${messages.length === 1 ? "" : "s"}`,
        detail: filePath,
      });
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Couldn't save chat",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setChatExportMenuOpen(false);
    }
  };

  // Close the Save-chat menu on outside click. mousedown so the menu
  // closes before any other click handler fires — avoids the "click
  // selects a message AND closes the menu at the same time" feel.
  useEffect(() => {
    if (!chatExportMenuOpen) return;
    const handler = (e: MouseEvent) => {
      const node = chatExportMenuRef.current;
      if (node && e.target instanceof Node && !node.contains(e.target)) {
        setChatExportMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [chatExportMenuOpen]);

  const TAB_LABELS: Record<Tab, string> = {
    idea: "Idea Canvas",
    research: "Research",
    validation: "Validation",
    brand: "Brand",
    "uk-setup": "UK Setup",
    spec: "Spec",
    screens: "Screens",
    overview: "Overview",
    options: "Options",
    chat: "AI Chat",
    pipeline: "Pipeline",
    artifacts: "Artifacts",
    audit: "Audit",
    sales: "Sales",
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Venture header */}
      <div
        style={{
          padding: "20px 28px",
          borderBottom: "1px solid var(--border-subtle)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "var(--text-primary)" }}>
            {venture.name}
          </h2>
          <div style={{ marginTop: 6 }}>
            <StageBadge stage={venture.stage} />
          </div>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            margin: "12px 28px 0",
            padding: "10px 14px",
            background: "#FEF2F2",
            color: "#991B1B",
            border: "1px solid #FECACA",
            borderRadius: 6,
            fontSize: 13,
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ flex: 1, wordBreak: "break-word" }}>{error}</div>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            style={{
              background: "none",
              border: "none",
              color: "#991B1B",
              fontSize: 16,
              lineHeight: 1,
              cursor: "pointer",
              padding: 0,
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* Tabs -- multi-row: max 10 per row, evenly split.
          14 tabs -> 7+7. 21 tabs -> 7+7+7. 10 or fewer -> single row.
          Only the LAST row gets the bottom border so per-row underlines
          don't visually stack between rows. */}
      {(() => {
        const tabKeys = Object.keys(TAB_LABELS) as Tab[];
        const MAX_PER_ROW = 10;
        const numRows = Math.max(1, Math.ceil(tabKeys.length / MAX_PER_ROW));
        const perRow = Math.ceil(tabKeys.length / numRows);
        const rows: Tab[][] = Array.from({ length: numRows }, (_, i) =>
          tabKeys.slice(i * perRow, (i + 1) * perRow)
        );
        return rows.map((rowKeys, rowIdx) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static list, order does not change
            key={`tab-row-${rowIdx}`}
            style={{
              display: "flex",
              gap: 0,
              borderBottom: rowIdx === rows.length - 1 ? "1px solid var(--border-subtle)" : "none",
              padding: "0 28px",
            }}
          >
            {rowKeys.map((t) => (
              <button
                type="button"
                key={t}
                onClick={() => setTab(t)}
                style={{
                  padding: "12px 18px",
                  fontWeight: tab === t ? 700 : 500,
                  fontSize: 14,
                  color: tab === t ? "var(--accent)" : "var(--text-tertiary)",
                  background: "none",
                  border: "none",
                  borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
                  cursor: "pointer",
                  marginBottom: rowIdx === rows.length - 1 ? -1 : 0,
                }}
              >
                {TAB_LABELS[t]}
              </button>
            ))}
          </div>
        ));
      })()}

      {/* Tab content */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        {tab === "idea" && (
          <IdeaTab
            venture={venture}
            manifest={manifest}
            onAdvanceStage={handleStageChange}
            onManifestUpdate={handleManifestUpdate}
          />
        )}
        {tab === "research" && (
          <ResearchTab
            venture={venture}
            manifest={manifest}
            onAdvanceStage={handleStageChange}
            onManifestUpdate={handleManifestUpdate}
            onRetryResearch={handleGenerateResearchReports}
            reportsGenerating={reportsGenerating}
          />
        )}
        {tab === "validation" && (
          <ValidationTab
            venture={venture}
            manifest={manifest}
            onAdvanceStage={handleStageChange}
            onManifestUpdate={handleManifestUpdate}
          />
        )}
        {tab === "brand" && (
          <BrandTab
            venture={venture}
            manifest={manifest}
            onAdvanceStage={handleStageChange}
            onManifestUpdate={handleManifestUpdate}
          />
        )}
        {tab === "uk-setup" && (
          // pt.33: keyed by venture so internal canvas state resets
          // when the user switches ventures (mirrors ArtifactsTab /
          // AuditTab key pattern). Manifest is passed through so the
          // tab can derive must-haves from the venture's flags
          // (hiresStaff / handlesPersonalData / takesPayments).
          <UkSetupTab key={venture.id} venture={venture} manifest={manifest} />
        )}
        {tab === "spec" && (
          // pt.41: same key pattern as UkSetupTab — internal canvas
          // state resets on venture switch. Manifest passed through
          // for parity even though deriveProductSpecRules currently
          // doesn't need flags; future appType-specific gating could.
          <SpecTab
            key={venture.id}
            venture={venture}
            manifest={manifest}
            onAdvanceStage={handleStageChange}
          />
        )}
        {tab === "screens" && (
          // pt.45: Screens tab (legacy stage enum WIREFRAME_READY).
          // Same key-by-venture-id pattern — canvas state resets on
          // switch. Manifest is currently unused inside ScreensTab
          // beyond the loading guard but kept on the prop signature
          // for future appType-aware gating (e.g. hiding the AUTH
          // shell type for browser_extension/game).
          <ScreensTab
            key={venture.id}
            venture={venture}
            manifest={manifest}
            onAdvanceStage={handleStageChange}
          />
        )}
        {tab === "overview" && (
          <OverviewTab
            venture={venture}
            manifest={manifest}
            onOpenInFinder={handleOpenInFinder}
            onRequestDelete={() => setDeleteConfirmOpen(true)}
            onRunPipeline={handleRunPipeline}
            isRunning={isRunning}
          />
        )}
        {tab === "chat" && (
          <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "8px 28px",
                borderBottom: "1px solid #F3F4F6",
                fontSize: 12,
                color: "#9CA3AF",
              }}
            >
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  minWidth: 0,
                }}
              >
                <span>
                  {chatHydrating
                    ? "Loading thread…"
                    : `${messages.length} message${messages.length === 1 ? "" : "s"} in this stage`}
                </span>
                {/* Web-search-active pill — only shown when the current
                    stage gets the tool attached AND the active provider
                    actually supports it. We compute both conditions
                    inline so the pill is honest: showing it when the
                    user's on a non-Anthropic provider would be a lie. */}
                {venture.stage === "RESEARCHED" && <WebSearchPill ventureId={venture.id} />}
                {/* Inline cue — rendered alongside the message counter
                    when the assistant has signalled readiness. Extra
                    surface for the same signal the button already pulses
                    on, in case the user's scrolled and the button's
                    drawn attention to the header as a whole. */}
                {reportsCueActive &&
                  venture.stage === "RESEARCHED" &&
                  manifest?.appType === "saas" &&
                  !reportsGenerating && (
                    <span
                      style={{
                        background: "#EEF2FF",
                        color: "#4338CA",
                        border: "1px solid #C7D2FE",
                        padding: "2px 8px",
                        borderRadius: 10,
                        fontSize: 11,
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                      }}
                    >
                      ✨ Ready to generate
                    </span>
                  )}
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {/* Generate Reports — only on RESEARCHED + appType=saas.
                    Dual trigger: always clickable manually; when the
                    assistant emits READY_TO_GENERATE_REPORTS in its
                    latest reply (see saasResearchIntakePrompt), the
                    button pulses + brightens + gets a ✨ prefix so the
                    founder can't miss the handoff. We don't auto-fire —
                    4 LLM calls aren't cheap and the founder should
                    approve the moment. */}
                {venture.stage === "RESEARCHED" && manifest?.appType === "saas" && !chatLoading && (
                  <button
                    type="button"
                    onClick={handleGenerateResearchReports}
                    disabled={reportsGenerating}
                    title={
                      reportsGenerating
                        ? "Running 4 LLM calls in parallel…"
                        : reportsCueActive
                          ? "Assistant signalled it's ready — click to generate the Core 4 research docs"
                          : "Generate the Core 4 research docs from this chat"
                    }
                    style={{
                      background: reportsGenerating
                        ? "#E0E7FF"
                        : reportsCueActive
                          ? "#6366F1"
                          : "#4F46E5",
                      border: `1px solid ${
                        reportsGenerating ? "#C7D2FE" : reportsCueActive ? "#818CF8" : "#4338CA"
                      }`,
                      color: reportsGenerating ? "#4338CA" : "#FFFFFF",
                      fontSize: 12,
                      fontWeight: 600,
                      padding: "4px 12px",
                      borderRadius: 4,
                      cursor: reportsGenerating ? "not-allowed" : "pointer",
                      opacity: reportsGenerating ? 0.85 : 1,
                      // When cued, pulse the box-shadow to draw the eye.
                      // 2s loop is slow enough to feel inviting, not
                      // anxious. Kept off otherwise to avoid constant
                      // motion in the chat header.
                      animation:
                        reportsCueActive && !reportsGenerating
                          ? "cuePulse 2s ease-in-out infinite"
                          : "none",
                    }}
                  >
                    {reportsGenerating
                      ? "Generating…"
                      : reportsCueActive
                        ? "✨ Generate Reports"
                        : "Generate Reports"}
                  </button>
                )}
                {/* pt.29 / pt.30a: Stop button for in-flight reports
                    run via the abort hook. Only rendered while a
                    controller is live (i.e. inside the try block of
                    handleGenerateResearchReports). Same optimistic-
                    stopping pattern as the pipeline / chat Stop
                    buttons — flips to disabled "Stopping…" the instant
                    the user clicks, before the Rust cancel round-trip
                    lands. */}
                {reportsGenerating && reportsTask.ref.current && (
                  <button
                    type="button"
                    onClick={reportsTask.cancel}
                    disabled={reportsTask.stopping}
                    title={
                      reportsTask.stopping
                        ? "Cancelling — waiting for in-flight calls to settle"
                        : "Cancel this reports run"
                    }
                    style={{
                      background: "#FFFFFF",
                      border: "1px solid #D1D5DB",
                      color: reportsTask.stopping ? "#9CA3AF" : "#374151",
                      fontSize: 12,
                      fontWeight: 600,
                      padding: "4px 12px",
                      borderRadius: 4,
                      cursor: reportsTask.stopping ? "not-allowed" : "pointer",
                      opacity: reportsTask.stopping ? 0.7 : 1,
                    }}
                  >
                    {reportsTask.stopping ? "Stopping…" : "Stop"}
                  </button>
                )}
                {/* Save Chat dropdown — export the (ventureId, stage)
                    thread as Markdown. Two actions: Copy (clipboard) and
                    Save as… (native file dialog). Stays visible during a
                    streaming reply so the user can snapshot even a
                    partial thread. Disabled when the thread is empty or
                    still hydrating from disk. */}
                {messages.length > 0 && !chatHydrating && (
                  <div ref={chatExportMenuRef} style={{ position: "relative" }}>
                    <button
                      type="button"
                      onClick={() => setChatExportMenuOpen((v) => !v)}
                      title="Save the current chat thread as Markdown"
                      style={{
                        background: "#FFFFFF",
                        border: "1px solid #D1D5DB",
                        color: "#374151",
                        fontSize: 12,
                        fontWeight: 500,
                        padding: "3px 10px",
                        borderRadius: 4,
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      Save Chat
                      <span style={{ fontSize: 10, opacity: 0.7 }}>▾</span>
                    </button>
                    {chatExportMenuOpen && (
                      <div
                        role="menu"
                        style={{
                          position: "absolute",
                          top: "calc(100% + 4px)",
                          right: 0,
                          background: "#FFFFFF",
                          border: "1px solid #E5E7EB",
                          borderRadius: 6,
                          boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                          minWidth: 200,
                          zIndex: 20,
                          overflow: "hidden",
                        }}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          onClick={handleCopyChatMarkdown}
                          style={chatExportMenuItemStyle}
                        >
                          Copy as Markdown
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={handleSaveChatMarkdown}
                          style={chatExportMenuItemStyle}
                        >
                          Save as Markdown…
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {chatLoading && (
                  // Stop button — aborts the in-flight stream via the
                  // chatAbortRef controller. The partial reply already
                  // streamed in stays in the bubble (and gets persisted on
                  // settle) so the thread is an honest transcript of what
                  // happened. Red outline to match the Audit-tab Stop.
                  // Flips to a disabled "Stopping…" state the instant the
                  // user clicks, so the UI feels responsive during the
                  // few-hundred-ms cancel round-trip through Rust.
                  <button
                    type="button"
                    onClick={handleCancelChat}
                    disabled={chatStopping}
                    title={
                      chatStopping
                        ? "Waiting for the provider to flush and close…"
                        : "Stop generating"
                    }
                    style={{
                      background: "#FFFFFF",
                      border: `1px solid ${chatStopping ? "#FCA5A5" : "#DC2626"}`,
                      color: chatStopping ? "#9CA3AF" : "#B91C1C",
                      fontSize: 12,
                      fontWeight: 600,
                      padding: "3px 10px",
                      borderRadius: 4,
                      cursor: chatStopping ? "not-allowed" : "pointer",
                      opacity: chatStopping ? 0.7 : 1,
                    }}
                  >
                    {chatStopping ? "Stopping…" : "Stop"}
                  </button>
                )}
                {messages.length > 0 && !chatHydrating && !chatLoading && (
                  <button
                    type="button"
                    onClick={handleClearChat}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#6B7280",
                      fontSize: 12,
                      cursor: "pointer",
                      padding: "2px 6px",
                    }}
                  >
                    Clear thread
                  </button>
                )}
              </div>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <ProjectChat
                ventureId={venture.id}
                ventureName={venture.name}
                currentStage={venture.stage}
                messages={
                  messages.length === 0
                    ? [
                        {
                          id: "welcome",
                          role: "assistant",
                          content: STAGE_FIRST_MESSAGE[venture.stage],
                          createdAt: new Date().toISOString(),
                        },
                      ]
                    : messages
                }
                isLoading={chatLoading}
                onSend={handleSend}
                // Attachment props are only meaningful during the
                // RESEARCHED-stage SaaS intake today, but we expose them
                // for every chat so the user can paste context in any
                // stage. The composer is a no-op UI change for stages
                // that don't feed attachments into a pipeline.
                attachments={chatAttachments}
                onAttach={handleAttach}
                onRemoveAttachment={handleRemoveAttachment}
              />
            </div>
            {/* Prompt Master savings ticker. Shown only after a real
                optimisation has registered savings (>0); otherwise the
                row is suppressed so a fallback transport doesn't
                advertise itself with a confusing "0 tokens saved" line. */}
            {promptMasterTokensSaved > 0 && (
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  fontSize: 11,
                  color: "#6B7280",
                  padding: "4px 12px 0",
                }}
                title="Total tokens Prompt Master has shaved off this session's system prompts"
              >
                Prompt Master: {promptMasterTokensSaved.toLocaleString()} tokens saved this session
              </div>
            )}
          </div>
        )}
        {tab === "pipeline" && (
          <div style={{ padding: 28 }}>
            {/* Pending review gates across all stages, with inline
                Approve/Reject. Self-hides when there are none. */}
            <PendingReviewsPanel
              ventureRoot={venture.rootPath}
              refreshToken={artifactsRescanToken}
              onAdvanceStage={handleStageChange}
            />
            {/* Single-click "run every implemented stage" -- skips
                already-complete stages, stops on first failure or
                pending review. */}
            <RunAllStagesButton
              venture={venture}
              manifest={manifest}
              onAllDone={() => setArtifactsRescanToken((n) => n + 1)}
            />
            {/* Stage-runner status overview -- read-only, surfaces what
                the 7 per-stage tabs only show one stage at a time. */}
            <PipelineStatusPanel
              ventureRoot={venture.rootPath}
              refreshToken={artifactsRescanToken}
              onSelectStage={(stage) => {
                // Map StageName -> Tab. Stages with no dedicated tab fall
                // back to a toast so the user knows clicking did something
                // even though we couldn't navigate.
                const TAB_FOR_STAGE: Partial<Record<StageName, Tab>> = {
                  RESEARCH: "research",
                  VALIDATION: "validation",
                  BRAND: "brand",
                  UK_SETUP: "uk-setup",
                  PRODUCT_SPEC: "spec",
                  WIREFRAME: "screens",
                  STITCH: "screens",
                  AUDIT: "audit",
                  BUILD: "audit",
                  // FINANCE + LAUNCH have no dedicated tab yet -- the
                  // skeletal runners exist but the UI hasn't been built.
                };
                const dest = TAB_FOR_STAGE[stage];
                if (dest) {
                  setTab(dest);
                } else {
                  pushToast({
                    kind: "info",
                    message: `${stage} stage has no dedicated tab yet`,
                    detail: "Skeletal runner exists; UI surface to come.",
                    ttlMs: 4000,
                  });
                }
              }}
            />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 12,
              }}
            >
              <div style={{ fontSize: 13, color: "#6B7280" }}>
                Click a stage to advance this venture.
              </div>
              {stageSaving && (
                <div style={{ fontSize: 12, color: "#6366F1", fontWeight: 600 }}>Saving…</div>
              )}
            </div>
            <StageGraph
              currentStage={venture.stage}
              onStageClick={(s) => handleStageChange(s as VentureStage)}
            />
            {activePlan && (
              <div style={{ marginTop: 20 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    margin: "0 0 12px",
                  }}
                >
                  <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>
                    Active Run: {activePlan.runId}
                  </h3>
                  {/* pt.28 / pt.30a: Stop button via the abort hook.
                      Visible only while the run is live — once
                      `isRunning` flips off in the finally block, the
                      button disappears and the active plan stays as a
                      read-only "last run" view. Disabled + relabelled
                      while the cancel is in flight so the user gets
                      immediate feedback. */}
                  {isRunning && pipelineTask.ref.current && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={pipelineTask.cancel}
                      disabled={pipelineTask.stopping}
                    >
                      {pipelineTask.stopping ? "Stopping…" : "Stop"}
                    </Button>
                  )}
                </div>
                {activePlan.steps.map((step) => (
                  <div
                    key={step.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 12px",
                      marginBottom: 6,
                      background: "#F9FAFB",
                      borderRadius: 6,
                      fontSize: 13,
                    }}
                  >
                    <span>
                      {step.status === "done"
                        ? "✅"
                        : step.status === "running"
                          ? "⏳"
                          : step.status === "failed"
                            ? "❌"
                            : step.status === "skipped"
                              ? "⏭️"
                              : "○"}
                    </span>
                    <span style={{ fontWeight: 600 }}>{step.name}</span>
                    <span style={{ color: "#9CA3AF" }}>{step.description}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {tab === "artifacts" && (
          // Keyed by venture so internal state (selection, scan results)
          // resets when the user switches ventures rather than carrying
          // an old selection over.
          <ArtifactsTab
            key={venture.id}
            ventureId={venture.id}
            ventureRoot={venture.rootPath}
            rescanToken={artifactsRescanToken}
          />
        )}
        {tab === "audit" && (
          <AuditTab
            key={venture.id}
            venture={venture}
            manifest={manifest}
            ventureId={venture.id}
            // pt.30d: needed by the export pipeline to read
            // 03_brand/names/name-candidates.json and derive brand
            // confidence into the JSON payload.
            ventureRoot={venture.rootPath}
            refreshToken={auditRefreshToken}
          />
        )}
        {tab === "sales" && <SalesTab venture={venture} />}
        {tab === "options" && <OptionsTab />}
      </div>

      {deleteConfirmOpen && (
        <DeleteVentureModal
          ventureName={venture.name}
          rootPath={venture.rootPath}
          deleteFromDisk={deleteFromDisk}
          onToggleDeleteFromDisk={setDeleteFromDisk}
          onCancel={() => {
            setDeleteConfirmOpen(false);
            setDeleteFromDisk(false);
          }}
          onConfirm={handleConfirmDelete}
          busy={deleting}
        />
      )}
    </div>
  );
}

/**
 * In-memory cache for the per-venture pre-flight result. Keyed by
 * venture id so switching ventures doesn't pollute another's badge.
 * 30-second TTL: long enough that the tab doesn't re-audit on every
 * render, short enough that a save in another tab is reflected within
 * half a minute. Lives at module scope rather than a hook because the
 * Overview tab unmounts on tab switch and we want the cache to survive.
 */
const PREFLIGHT_CACHE_TTL_MS = 30_000;
const preflightCache = new Map<
  string,
  { fetchedAt: number; nextStage: VentureStage; result: AdvancePreflight }
>();

function NextStageProgressHint({
  venture,
  manifest,
}: {
  venture: Venture;
  manifest: VentureManifest | null;
}) {
  const nextStage = nextStageAfter(venture.stage);
  const [hint, setHint] = useState<{
    blockers: number;
    warnings: number;
    loading: boolean;
    error: string | null;
  }>({ blockers: 0, warnings: 0, loading: nextStage !== null, error: null });

  useEffect(() => {
    if (!nextStage) {
      setHint({ blockers: 0, warnings: 0, loading: false, error: null });
      return;
    }
    let cancelled = false;
    const cacheKey = `${venture.id}::${nextStage}`;
    const cached = preflightCache.get(cacheKey);
    const fresh = cached && Date.now() - cached.fetchedAt < PREFLIGHT_CACHE_TTL_MS;
    if (fresh && cached.nextStage === nextStage) {
      setHint({
        blockers: cached.result.blockers.length,
        warnings: cached.result.warnings.length,
        loading: false,
        error: null,
      });
      return;
    }
    setHint((prev) => ({ ...prev, loading: true, error: null }));
    runAdvancePreflight({
      ventureId: venture.id,
      ventureRoot: venture.rootPath,
      nextStage,
      manifest,
    })
      .then((result) => {
        if (cancelled) return;
        preflightCache.set(cacheKey, { fetchedAt: Date.now(), nextStage, result });
        setHint({
          blockers: result.blockers.length,
          warnings: result.warnings.length,
          loading: false,
          error: null,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setHint({ blockers: 0, warnings: 0, loading: false, error: msg });
      });
    return () => {
      cancelled = true;
    };
  }, [venture.id, venture.rootPath, nextStage, manifest]);

  if (!nextStage) {
    return (
      <span style={{ fontSize: 11, color: "#6B7280" }}>End of pipeline — no further stages.</span>
    );
  }
  if (hint.loading) {
    return (
      <span style={{ fontSize: 11, color: "#6B7280" }}>
        Checking readiness for {nextStage.replace(/_/g, " ")}…
      </span>
    );
  }
  if (hint.error) {
    return (
      <span style={{ fontSize: 11, color: "#92400E" }} title={hint.error}>
        Couldn't run pre-flight audit.
      </span>
    );
  }
  const total = hint.blockers + hint.warnings;
  if (total === 0) {
    return (
      <span style={{ fontSize: 11, color: "#059669", fontWeight: 600 }}>
        ✅ Ready to advance to {nextStage.replace(/_/g, " ")}.
      </span>
    );
  }
  const color = hint.blockers > 0 ? "#991B1B" : "#92400E";
  return (
    <span style={{ fontSize: 11, color, fontWeight: 600 }}>
      {hint.blockers > 0
        ? `${hint.blockers} blocker${hint.blockers === 1 ? "" : "s"}`
        : `${hint.warnings} warning${hint.warnings === 1 ? "" : "s"}`}{" "}
      before {nextStage.replace(/_/g, " ")}
      {hint.blockers > 0 && hint.warnings > 0
        ? ` (+${hint.warnings} warning${hint.warnings === 1 ? "" : "s"})`
        : ""}
    </span>
  );
}

function OverviewTab({
  venture,
  manifest,
  onOpenInFinder,
  onRequestDelete,
  onRunPipeline,
  isRunning,
}: {
  venture: Venture;
  manifest: VentureManifest | null;
  onOpenInFinder: () => void;
  onRequestDelete: () => void;
  onRunPipeline: () => void;
  isRunning: boolean;
}) {
  return (
    <div style={{ padding: 28, display: "flex", flexDirection: "column", gap: 20 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 16,
        }}
      >
        <Card
          title="Current Stage"
          description={`${venture.stage.replace(/_/g, " ")}`}
          footer={<NextStageProgressHint venture={venture} manifest={manifest} />}
        />
        <Card title="Venture ID" description={venture.id} />
        <Card title="Artifacts" description="Scan pending" />
        <Card title="Handoffs" description="None active" />
      </div>
      <Card title="Quick Actions">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Button variant="primary" size="sm" onClick={onRunPipeline} disabled={isRunning}>
            {isRunning ? "Running…" : "Run Pipeline"}
          </Button>
          <Button variant="secondary" size="sm" onClick={onOpenInFinder}>
            Open in Finder
          </Button>
          <Button variant="secondary" size="sm">
            Send to Builder
          </Button>
        </div>
        <div
          style={{
            marginTop: 10,
            fontSize: 11,
            color: "#9CA3AF",
            fontFamily: "ui-monospace, monospace",
            wordBreak: "break-all",
          }}
          title={venture.rootPath}
        >
          {venture.rootPath}
        </div>
      </Card>
      <VentureProviderPicker ventureId={venture.id} />
      <Card title="Danger zone">
        <div style={{ fontSize: 13, color: "#6B7280", marginBottom: 10 }}>
          Removes this venture from your library. Files on disk are preserved unless you explicitly
          opt in to deleting them.
        </div>
        <button
          type="button"
          onClick={onRequestDelete}
          style={{
            padding: "8px 14px",
            background: "#FFFFFF",
            color: "#B91C1C",
            border: "1px solid #FCA5A5",
            borderRadius: 6,
            fontWeight: 600,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          Delete venture…
        </button>
      </Card>
    </div>
  );
}

function DeleteVentureModal({
  ventureName,
  rootPath,
  deleteFromDisk,
  onToggleDeleteFromDisk,
  onCancel,
  onConfirm,
  busy,
}: {
  ventureName: string;
  rootPath: string;
  deleteFromDisk: boolean;
  onToggleDeleteFromDisk: (v: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: role chosen intentionally; refactor deferred
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-venture-title"
      onClick={busy ? undefined : onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#FFFFFF",
          borderRadius: 12,
          padding: 28,
          width: "min(440px, calc(100vw - 32px))",
          boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <h2
          id="delete-venture-title"
          style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#111827" }}
        >
          Delete "{ventureName}"?
        </h2>
        <p style={{ margin: 0, fontSize: 13, color: "#374151", lineHeight: 1.5 }}>
          The venture will be removed from your library and its chat history will be lost. You can
          re-import the folder later if you keep it.
        </p>
        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            padding: 12,
            border: "1px solid #FCA5A5",
            background: "#FEF2F2",
            borderRadius: 6,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={deleteFromDisk}
            disabled={busy}
            onChange={(e) => onToggleDeleteFromDisk(e.target.checked)}
            style={{ marginTop: 2 }}
          />
          <div style={{ fontSize: 13, color: "#7F1D1D" }}>
            <div style={{ fontWeight: 700 }}>Also delete folder on disk</div>
            <div
              style={{
                marginTop: 2,
                fontFamily: "ui-monospace, monospace",
                fontSize: 11,
                color: "#991B1B",
                wordBreak: "break-all",
              }}
            >
              {rootPath}
            </div>
            <div style={{ marginTop: 4, fontSize: 12 }}>
              This is permanent and cannot be undone.
            </div>
          </div>
        </label>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 4,
          }}
        >
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            style={{
              padding: "8px 14px",
              background: "#FFFFFF",
              color: "#374151",
              border: "1px solid #D1D5DB",
              borderRadius: 6,
              fontWeight: 600,
              fontSize: 13,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            style={{
              padding: "8px 14px",
              background: busy ? "#FCA5A5" : "#DC2626",
              color: "#FFFFFF",
              border: "none",
              borderRadius: 6,
              fontWeight: 600,
              fontSize: 13,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "Deleting…" : deleteFromDisk ? "Delete venture + folder" : "Delete venture"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Small "🔍 Web search on" pill rendered in the chat header when the
 * active provider supports web search and the current stage enables it.
 *
 * We resolve the active provider async (per-venture override wins), so
 * this is its own component with local state rather than threading yet
 * another derived value through VentureDashboard's render path. The
 * resolution is cheap (SQLite point lookup) and only runs on venture
 * switch.
 */
function WebSearchPill({ ventureId }: { ventureId: string }) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    let cancelled = false;
    pickActiveProvider(ventureId)
      .then((pid) => {
        if (cancelled) return;
        if (!pid) {
          setActive(false);
          return;
        }
        const entry = PROVIDER_CATALOG.find((p) => p.id === pid);
        setActive(entry?.supportsWebSearch === true);
      })
      .catch(() => {
        if (!cancelled) setActive(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ventureId]);

  if (!active) return null;
  return (
    <span
      title="Web search is enabled for this stage — the assistant can pull fresh data."
      style={{
        background: "#ECFDF5",
        color: "#065F46",
        border: "1px solid #A7F3D0",
        padding: "2px 8px",
        borderRadius: 10,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      🔍 Web search on
    </span>
  );
}
