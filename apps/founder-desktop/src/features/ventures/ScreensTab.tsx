/**
 * ScreensTab (pt.45 + pt.47) — guided UI for the Screens stage.
 *
 * Reads + writes `06_product/wireframes/screens-canvas.json` (the
 * canvas defined in @founder-os/domain/screens). The canvas captures
 * a screen INVENTORY — name, description, shell type, feature/entity
 * mappings, notes — NOT element-level layout. Visual generation is
 * downstream Stitch / v0 / Figma Make work, fed by `create-stitch-pack`
 * (pt.44).
 *
 * Naming compromise (see screens.ts header): the stage enum value is
 * still `WIREFRAME_READY` (legacy from pre-pt.41) but everything
 * user-facing in this file is "Screens". The folder is wireframes/
 * to match the existing skeleton helper. Don't rename either without
 * doing the 13-file blast radius pass.
 *
 * Pattern mirrors SpecTab (pt.41 + pt.42a): hydration ref + 600ms
 * debounced autosave + Saved/Saving/Unsaved indicator + must-haves
 * panel on the right driven by `deriveScreensRules`. The pt.47 AI
 * draft flow swaps the right column for a draft panel while the
 * founder reviews per-section apply / merge / skip controls.
 *
 * Spec-canvas read: best-effort, in parallel with the screens canvas
 * load. Used for two things — (1) populating the feature/entity
 * multi-select pills, (2) the `must-feature-coverage` rule on the
 * must-haves panel. Missing or malformed spec falls back to empty
 * arrays; the underlying issue is already flagged by the spec audit
 * block, no need to re-surface here.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ScreensCanvasSchema,
  ProductSpecCanvasSchema,
  ShellTypeSchema,
  SHELL_TYPE_LABELS,
  SHELL_TYPE_DESCRIPTIONS,
  createEmptyScreensCanvas,
  deriveScreensRules,
  isScreensCanvasComplete,
  type ScreensCanvas,
  type Screen,
  type ShellType,
  type ProductSpecCanvas,
  type Venture,
  type VentureManifest,
} from "@founder-os/domain";
import {
  getScreensCanvasPath,
  getSpecCanvasPath,
} from "@founder-os/workspace-core";
import { pushToast } from "../../lib/toasts.js";
import {
  draftScreensCanvas,
  type ScreensDraftResult,
} from "../../lib/screens-drafter.js";

const SAVE_DEBOUNCE_MS = 600;

// ─────────────────────────────────────────────────────────────────
// Draft panel state machine (pt.47)
// Mirror of the SpecTab state machine, narrower because the
// ScreensCanvas has only two acceptable surfaces: the screens list
// (replace/merge/skip) and the notes singleton (replace/skip).
// ─────────────────────────────────────────────────────────────────

/** Phase of the AI draft flow. `idle` = panel closed, no draft attempt
 *  yet; `loading` = streaming from the provider; `success` = canvas
 *  ready for per-section apply; `error` = surfaced to the panel as a
 *  retryable message. Identical vocabulary to SpecTab's DraftPhase. */
type DraftPhase = "idle" | "loading" | "success" | "error";

/** Per-section apply state shown in the panel as the founder commits
 *  (or skips) each section of the AI draft. `pending` is the initial
 *  state. */
type SectionState = "pending" | "applied-replace" | "applied-merge" | "skipped";

/** Section ids the panel cycles through. Just two for screens — the
 *  bulk of the canvas IS the screens list, and notes is a singleton.
 *  The drafter's spec/entity/feature mappings live INSIDE each
 *  screen object, so they apply atomically with the screens row. */
type DraftSectionId = "screens" | "notes";

type Props = {
  venture: Venture;
  manifest: VentureManifest | null;
};

/**
 * Stable id for new screens. crypto.randomUUID() everywhere it's
 * available; fall back to a timestamp + random tail otherwise. Mirror
 * of SpecTab's `newId`.
 */
function newId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The narrow snapshot of the spec canvas this tab actually consumes.
 * Built once after the spec read so the multi-select pills and the
 * deriveScreensRules call don't both have to handle the
 * possibly-null spec. Empty arrays when no spec on disk.
 */
type SpecSnapshot = {
  features: Array<{ id: string; name: string; priority: string }>;
  entities: Array<{ id: string; name: string }>;
};

const EMPTY_SPEC_SNAPSHOT: SpecSnapshot = { features: [], entities: [] };

function buildSpecSnapshot(spec: ProductSpecCanvas | null): SpecSnapshot {
  if (!spec) return EMPTY_SPEC_SNAPSHOT;
  return {
    features: spec.features.map((f) => ({
      id: f.id,
      name: f.name,
      priority: f.priority,
    })),
    entities: spec.dataModel.entities.map((e) => ({
      id: e.id,
      name: e.name,
    })),
  };
}

export function ScreensTab({ venture, manifest }: Props) {
  const canvasPath = useMemo(
    () => getScreensCanvasPath(venture.rootPath),
    [venture.rootPath]
  );
  const specPath = useMemo(
    () => getSpecCanvasPath(venture.rootPath),
    [venture.rootPath]
  );

  const [canvas, setCanvas] = useState<ScreensCanvas | null>(null);
  const [specSnapshot, setSpecSnapshot] = useState<SpecSnapshot>(EMPTY_SPEC_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "unsaved">(
    "saved"
  );

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydratedRef = useRef(false);

  // Draft panel state (pt.47) — separate from saveStatus so a stalled
  // draft never blocks autosave of the founder's existing edits.
  // Mirror of SpecTab's draft state.
  const [draftPhase, setDraftPhase] = useState<DraftPhase>("idle");
  const [draftCanvas, setDraftCanvas] = useState<ScreensCanvas | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftProvider, setDraftProvider] = useState<string | null>(null);
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [sectionStates, setSectionStates] = useState<
    Partial<Record<DraftSectionId, SectionState>>
  >({});
  /** Token-pulse counter — drives the panel's liveness label. We
   *  don't render partial JSON. */
  const [draftDeltaCount, setDraftDeltaCount] = useState(0);
  const draftAbortRef = useRef<AbortController | null>(null);

  /** Reset the draft surface back to closed/idle — used by Discard,
   *  by venture switch, and by Cancel-during-loading. */
  const resetDraft = () => {
    if (draftAbortRef.current) {
      draftAbortRef.current.abort();
      draftAbortRef.current = null;
    }
    setDraftPhase("idle");
    setDraftCanvas(null);
    setDraftError(null);
    setDraftProvider(null);
    setDraftModel(null);
    setSectionStates({});
    setDraftDeltaCount(0);
  };

  // Reset the draft panel when the founder switches venture — a
  // draft for venture A shouldn't survive into venture B's view.
  useEffect(() => {
    resetDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venture.id]);

  // Load canvas + spec snapshot in parallel on mount / venture switch.
  // Spec read is best-effort: the underlying issue is already flagged
  // by the spec audit block, so swallowing missing/malformed here is
  // safe. The dropdowns just show an empty-state message when the
  // snapshot has no features/entities.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      hydratedRef.current = false;

      // Screens canvas — primary state for this tab.
      try {
        const exists = await invoke<boolean>("path_exists", { path: canvasPath });
        if (exists) {
          const raw = await invoke<string>("read_file", { path: canvasPath });
          const parsed = ScreensCanvasSchema.safeParse(JSON.parse(raw));
          if (parsed.success) {
            if (!cancelled) setCanvas(parsed.data);
          } else {
            // Malformed file on disk — render with fresh defaults but
            // DON'T overwrite (mirror SpecTab policy). Audit step
            // surfaces the parse failure as `screens.json.invalid`.
            console.warn(
              "[screens] canvas parse failed, using fresh defaults",
              parsed.error
            );
            if (!cancelled) setCanvas(createEmptyScreensCanvas(venture.id));
          }
        } else {
          // No canvas yet — happens before the first pipeline run that
          // hits ensure-screens. Initialise so the founder can edit
          // immediately; autosave creates the file on first change.
          if (!cancelled) setCanvas(createEmptyScreensCanvas(venture.id));
        }
      } catch (err) {
        console.error("[screens] canvas load failed", err);
        if (!cancelled) setCanvas(createEmptyScreensCanvas(venture.id));
      }

      // Spec snapshot — best-effort. Don't surface errors; the spec
      // audit already covers them and we don't want a broken spec to
      // block editing screens.
      try {
        const specExists = await invoke<boolean>("path_exists", { path: specPath });
        if (specExists) {
          const rawSpec = await invoke<string>("read_file", { path: specPath });
          const parsedSpec = ProductSpecCanvasSchema.safeParse(JSON.parse(rawSpec));
          if (!cancelled) {
            setSpecSnapshot(
              parsedSpec.success
                ? buildSpecSnapshot(parsedSpec.data)
                : EMPTY_SPEC_SNAPSHOT
            );
          }
        } else if (!cancelled) {
          setSpecSnapshot(EMPTY_SPEC_SNAPSHOT);
        }
      } catch (err) {
        console.warn("[screens] spec snapshot load failed (non-fatal)", err);
        if (!cancelled) setSpecSnapshot(EMPTY_SPEC_SNAPSHOT);
      }

      if (!cancelled) {
        setLoading(false);
        hydratedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canvasPath, specPath, venture.id]);

  // Autosave on canvas change. Mirror of SpecTab — set unsaved
  // immediately, debounce the actual write, surface failures via toast.
  useEffect(() => {
    if (!canvas || !hydratedRef.current) return;
    setSaveStatus("unsaved");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      setSaveStatus("saving");
      try {
        const next = { ...canvas, updatedAt: new Date().toISOString() };
        await invoke("write_file", {
          path: canvasPath,
          content: JSON.stringify(next, null, 2) + "\n",
        });
        setSaveStatus("saved");
      } catch (err) {
        console.error("[screens] save failed", err);
        pushToast({
          kind: "error",
          message: "Couldn't save Screens canvas",
          detail: err instanceof Error ? err.message : String(err),
        });
        setSaveStatus("unsaved");
      }
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [canvas, canvasPath]);

  if (loading || !canvas || !manifest) {
    return (
      <div style={{ padding: 28, color: "#6B7280" }}>Loading Screens canvas…</div>
    );
  }

  const rules = deriveScreensRules(canvas, specSnapshot);
  const passCount = rules.filter((r) => r.pass).length;
  const complete = isScreensCanvasComplete(canvas, specSnapshot);

  // ─────────────────────────────────────────────────────────────
  // Update helpers — list pattern mirrors SpecTab's section
  // editors. Keep the JSX below readable.
  // ─────────────────────────────────────────────────────────────

  const updateNotes = (notes: string) =>
    setCanvas((cur) => (cur ? { ...cur, notes } : cur));

  const updateScreen = (id: string, patch: Partial<Screen>) =>
    setCanvas((cur) =>
      cur
        ? {
            ...cur,
            screens: cur.screens.map((s) =>
              s.id === id ? { ...s, ...patch } : s
            ),
          }
        : cur
    );
  const addScreen = () =>
    setCanvas((cur) =>
      cur
        ? {
            ...cur,
            screens: [
              ...cur.screens,
              {
                id: newId("screen"),
                name: "",
                description: "",
                shellType: "DASHBOARD" as ShellType,
                featureIds: [],
                entityIds: [],
                notes: "",
              },
            ],
          }
        : cur
    );
  const removeScreen = (id: string) =>
    setCanvas((cur) =>
      cur
        ? { ...cur, screens: cur.screens.filter((s) => s.id !== id) }
        : cur
    );

  // ─────────────────────────────────────────────────────────────
  // Draft flow (pt.47) — mirror of SpecTab's startDraft/apply*
  // ─────────────────────────────────────────────────────────────

  /** Kick off an AI draft. Aborts any in-flight attempt so we don't
   *  end up with two streams writing into the same state. */
  const startDraft = async () => {
    if (!manifest) {
      pushToast({
        kind: "error",
        message: "Can't draft yet",
        detail: "Venture manifest hasn't loaded.",
      });
      return;
    }
    if (draftAbortRef.current) draftAbortRef.current.abort();

    setDraftPhase("loading");
    setDraftCanvas(null);
    setDraftError(null);
    setDraftProvider(null);
    setDraftModel(null);
    setSectionStates({});
    setDraftDeltaCount(0);

    const controller = new AbortController();
    draftAbortRef.current = controller;

    let result: ScreensDraftResult;
    try {
      result = await draftScreensCanvas({
        venture,
        manifest,
        signal: controller.signal,
        onDelta: () => setDraftDeltaCount((c) => c + 1),
      });
    } catch (err) {
      // draftScreensCanvas catches its own errors and returns
      // {ok:false}; this catch is paranoia for an unexpected throw
      // (e.g. a missed import-time failure). Treat it the same way.
      result = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // If the user already moved on (closed the panel, switched
    // venture) the abort controller will have been cleared. Bail
    // rather than stomp over a fresh state.
    if (draftAbortRef.current !== controller) return;
    draftAbortRef.current = null;

    if (result.ok) {
      setDraftCanvas(result.canvas);
      setDraftProvider(result.providerDisplayName);
      setDraftModel(result.model);
      setDraftPhase("success");
    } else {
      setDraftError(result.error);
      setDraftPhase("error");
    }
  };

  /** Mark a section's state. Used by every apply / skip path so the
   *  panel UI can show "Applied (replaced)" / "Skipped" stamps. */
  const stampSection = (id: DraftSectionId, state: SectionState) =>
    setSectionStates((s) => ({ ...s, [id]: state }));

  /** Screens list apply. Replace overwrites; Merge appends. We don't
   *  dedupe by id on merge — the AI's ids are random enough that
   *  collisions with the founder's existing list are statistically
   *  negligible, and de-duping by name would be too aggressive (the
   *  founder may legitimately want both "Settings" entries side-by-
   *  side to compare framings). */
  const applyScreens = (mode: "replace" | "merge" | "skip") => {
    if (!draftCanvas) return;
    setCanvas((cur) => {
      if (!cur) return cur;
      if (mode === "replace") return { ...cur, screens: draftCanvas.screens };
      if (mode === "merge")
        return { ...cur, screens: [...cur.screens, ...draftCanvas.screens] };
      return cur;
    });
    stampSection(
      "screens",
      mode === "skip"
        ? "skipped"
        : mode === "replace"
          ? "applied-replace"
          : "applied-merge"
    );
  };

  /** Singleton-section apply. Notes uses this — there's no meaningful
   *  "merge" for prose (you can't append paragraphs without producing
   *  Frankenstein notes), so the panel only offers Replace / Skip. */
  const applyNotes = (mode: "replace" | "skip") => {
    if (!draftCanvas) return;
    if (mode === "replace") updateNotes(draftCanvas.notes);
    stampSection("notes", mode === "replace" ? "applied-replace" : "skipped");
  };

  /** Convenience: apply both sections in one mode. Notes treats
   *  "merge" the same as "replace" since merging prose is meaningless.
   *  We post a toast so the founder gets immediate confirmation
   *  rather than scanning the section stamps. */
  const applyAll = (mode: "replace" | "merge") => {
    if (!draftCanvas) return;
    applyScreens(mode);
    applyNotes("replace");
    pushToast({
      kind: "success",
      message: `Applied AI draft (${mode})`,
      detail:
        mode === "replace"
          ? "Screens list and notes replaced from the draft."
          : "Screens merged with the draft; notes replaced.",
    });
  };

  return (
    <div
      style={{
        padding: 28,
        display: "grid",
        gridTemplateColumns: "1fr 320px",
        gap: 24,
      }}
    >
      {/* Main canvas column */}
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#111827" }}>
              Screens
            </h2>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: "#6B7280" }}>
              Inventory of product screens — name, shell shape, mapped features and
              entities. Stitch / v0 / Figma Make handle the visual layout downstream.
              Saved to <code>06_product/wireframes/screens-canvas.json</code>.
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <SaveIndicator status={saveStatus} />
            <DraftWithAiButton
              phase={draftPhase}
              onClick={() => {
                if (draftPhase === "idle" || draftPhase === "error") {
                  void startDraft();
                }
              }}
            />
          </div>
        </div>

        {/* Empty-state nudge when there are no screens yet — mirrors
            the SpecTab section descriptions in tone. Renders once;
            disappears as soon as the founder adds the first screen. */}
        {canvas.screens.length === 0 && (
          <div
            style={{
              padding: 14,
              background: "#F9FAFB",
              border: "1px dashed #D1D5DB",
              borderRadius: 8,
              fontSize: 12,
              color: "#4B5563",
              lineHeight: 1.5,
            }}
          >
            Start with the screen the user lands on. Aim for 5–12 total — one screen
            per Must-priority feature is too granular, one mega-screen is too
            monolithic. Cross-cutting features (auth, settings) live on their own
            screens; in-line concerns (toasts, modals) don't.
          </div>
        )}

        {/* Screens list ─────────────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {canvas.screens.map((s) => (
            <ScreenCard
              key={s.id}
              screen={s}
              specSnapshot={specSnapshot}
              onChange={(patch) => updateScreen(s.id, patch)}
              onRemove={() => removeScreen(s.id)}
            />
          ))}
          <AddRowButton label="+ Add screen" onClick={addScreen} />
        </div>

        {/* Notes ────────────────────────────────────────────────── */}
        <Section title="Notes" icon="🗒️">
          <p style={{ margin: 0, fontSize: 12, color: "#6B7280" }}>
            Anything that doesn't fit the per-screen fields — global navigation,
            shared layout decisions, responsive notes.
          </p>
          <textarea
            value={canvas.notes}
            onChange={(e) => updateNotes(e.target.value)}
            placeholder="Top-level nav is a left sidebar on desktop, bottom tabs on mobile. All forms use the same validation pattern (inline + summary)."
            rows={4}
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </Section>
      </div>

      {/* ── Right column: Draft panel (when active) or Must-haves ── */}
      {draftPhase !== "idle" ? (
        <ScreensDraftPanel
          phase={draftPhase}
          draftCanvas={draftCanvas}
          error={draftError}
          providerDisplayName={draftProvider}
          model={draftModel}
          deltaCount={draftDeltaCount}
          sectionStates={sectionStates}
          specSnapshot={specSnapshot}
          onCancel={() => {
            // Cancel-during-loading: abort + return to idle.
            // Close-after-success: same path; the user can re-draft.
            resetDraft();
          }}
          onRetry={() => void startDraft()}
          onApplyAll={applyAll}
          onApplyScreens={applyScreens}
          onApplyNotes={applyNotes}
        />
      ) : (
      <aside
        style={{
          padding: 16,
          background: "#F9FAFB",
          border: "1px solid #E5E7EB",
          borderRadius: 8,
          alignSelf: "start",
          position: "sticky",
          top: 16,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 12,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#111827" }}>
            Must-haves
          </h3>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: passCount === rules.length ? "#059669" : "#6B7280",
            }}
          >
            {passCount} / {rules.length}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rules.map((rule) => (
            <div
              key={rule.id}
              style={{ display: "flex", alignItems: "flex-start", gap: 8 }}
            >
              <span
                style={{
                  fontSize: 12,
                  marginTop: 1,
                  color: rule.pass ? "#059669" : "#9CA3AF",
                }}
              >
                {rule.pass ? "✅" : "○"}
              </span>
              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: rule.pass ? "#111827" : "#374151",
                  }}
                >
                  {rule.label}
                </div>
                <div style={{ fontSize: 11, color: "#6B7280" }}>
                  {rule.description}
                </div>
              </div>
            </div>
          ))}
        </div>
        {complete && (
          <div
            style={{
              marginTop: 14,
              padding: 10,
              background: "#ECFDF5",
              border: "1px solid #A7F3D0",
              borderRadius: 6,
              fontSize: 12,
              color: "#065F46",
              fontWeight: 600,
            }}
          >
            ✓ Screens cover the must-haves — ready to advance to Stitch.
          </div>
        )}
        {/* Spec-not-loaded hint. Helpful when the founder lands here
            from a stage advance but the spec was never filled in — the
            feature multi-select and the coverage rule will both look
            broken otherwise. */}
        {specSnapshot.features.length === 0 && (
          <div
            style={{
              marginTop: 12,
              fontSize: 11,
              color: "#9CA3AF",
              lineHeight: 1.5,
            }}
          >
            No spec features detected yet — fill in the Spec tab first to enable
            feature mapping and the coverage check.
          </div>
        )}
      </aside>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ScreenCard — one row per screen
// ─────────────────────────────────────────────────────────────────

function ScreenCard({
  screen,
  specSnapshot,
  onChange,
  onRemove,
}: {
  screen: Screen;
  specSnapshot: SpecSnapshot;
  onChange: (patch: Partial<Screen>) => void;
  onRemove: () => void;
}) {
  // Toggle helper for the multi-select pill grids. Keeps the JSX
  // below uncluttered and the toggling logic centralized so feature
  // and entity behave identically.
  const toggleFeature = (id: string) => {
    const has = screen.featureIds.includes(id);
    onChange({
      featureIds: has
        ? screen.featureIds.filter((x) => x !== id)
        : [...screen.featureIds, id],
    });
  };
  const toggleEntity = (id: string) => {
    const has = screen.entityIds.includes(id);
    onChange({
      entityIds: has
        ? screen.entityIds.filter((x) => x !== id)
        : [...screen.entityIds, id],
    });
  };

  const shellDescription = SHELL_TYPE_DESCRIPTIONS[screen.shellType];

  return (
    <CardShell>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="text"
          value={screen.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Project list"
          style={{ ...inputStyle, flex: 1, fontWeight: 600 }}
        />
        <select
          value={screen.shellType}
          onChange={(e) =>
            onChange({ shellType: e.target.value as ShellType })
          }
          title={shellDescription}
          style={{ ...inputStyle, width: "auto" }}
        >
          {ShellTypeSchema.options.map((opt) => (
            <option key={opt} value={opt} title={SHELL_TYPE_DESCRIPTIONS[opt]}>
              {SHELL_TYPE_LABELS[opt]}
            </option>
          ))}
        </select>
        <RemoveButton onClick={onRemove} />
      </div>
      <div
        style={{
          fontSize: 11,
          color: "#6B7280",
          marginTop: -2,
          fontStyle: "italic",
        }}
      >
        {shellDescription}
      </div>
      <Field label="Description">
        <textarea
          value={screen.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="What the user does here, in user terms. e.g. Browse, search, and open one of their projects."
          rows={2}
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </Field>

      {/* Feature mapping ───────────────────────────────────────── */}
      <Field label="Features fulfilled">
        {specSnapshot.features.length === 0 ? (
          <EmptyHint>
            Spec features will appear here once the spec is filled in.
          </EmptyHint>
        ) : (
          <PillGrid>
            {specSnapshot.features.map((f) => {
              const selected = screen.featureIds.includes(f.id);
              return (
                <Pill
                  key={f.id}
                  selected={selected}
                  // Highlight Must-priority features so the founder's
                  // eye lands on the ones the coverage rule cares
                  // about. The visible glyph is enough — no extra
                  // tooltip noise for "should" / "nice".
                  badge={f.priority === "must" ? "Must" : null}
                  onClick={() => toggleFeature(f.id)}
                >
                  {f.name.trim() || "(unnamed feature)"}
                </Pill>
              );
            })}
          </PillGrid>
        )}
      </Field>

      {/* Entity mapping ────────────────────────────────────────── */}
      <Field label="Entities touched (optional)">
        {specSnapshot.entities.length === 0 ? (
          <EmptyHint>
            Spec entities will appear here once the data model is filled in.
          </EmptyHint>
        ) : (
          <PillGrid>
            {specSnapshot.entities.map((e) => {
              const selected = screen.entityIds.includes(e.id);
              return (
                <Pill
                  key={e.id}
                  selected={selected}
                  onClick={() => toggleEntity(e.id)}
                >
                  {e.name.trim() || "(unnamed entity)"}
                </Pill>
              );
            })}
          </PillGrid>
        )}
      </Field>

      <Field label="Notes (optional)">
        <textarea
          value={screen.notes}
          onChange={(e) => onChange({ notes: e.target.value })}
          placeholder="Empty state copy hints, responsive behaviour, edge cases the shell type doesn't capture."
          rows={2}
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </Field>
    </CardShell>
  );
}

// ─────────────────────────────────────────────────────────────────
// Sub-components — Section, Field, Card, Pill, AddRowButton
// (Pattern intentionally mirrors SpecTab so visual parity is
// preserved across the two stages.)
// ─────────────────────────────────────────────────────────────────

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        padding: 16,
        background: "#FFFFFF",
        border: "1px solid #E5E7EB",
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#111827" }}>
        <span style={{ marginRight: 6 }}>{icon}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11, color: "#6B7280", fontWeight: 600 }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: 12,
        background: "#FAFAFB",
        border: "1px solid #E5E7EB",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {children}
    </div>
  );
}

function AddRowButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        alignSelf: "flex-start",
        padding: "6px 12px",
        fontSize: 12,
        background: "#FFFFFF",
        color: "#4338CA",
        border: "1px dashed #C7D2FE",
        borderRadius: 4,
        cursor: "pointer",
        fontWeight: 600,
      }}
    >
      {label}
    </button>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Remove"
      style={{
        marginLeft: "auto",
        padding: "2px 8px",
        fontSize: 11,
        background: "#FFFFFF",
        color: "#DC2626",
        border: "1px solid #FEE2E2",
        borderRadius: 4,
        cursor: "pointer",
        fontWeight: 600,
      }}
    >
      Remove
    </button>
  );
}

function PillGrid({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        padding: "6px 4px",
      }}
    >
      {children}
    </div>
  );
}

function Pill({
  children,
  selected,
  badge,
  onClick,
}: {
  children: React.ReactNode;
  selected: boolean;
  badge?: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "4px 10px",
        fontSize: 12,
        fontWeight: 600,
        background: selected ? "#EEF2FF" : "#FFFFFF",
        color: selected ? "#4338CA" : "#374151",
        border: `1px solid ${selected ? "#C7D2FE" : "#E5E7EB"}`,
        borderRadius: 999,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span>{children}</span>
      {badge && (
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: "1px 5px",
            background: selected ? "#4338CA" : "#F3F4F6",
            color: selected ? "#FFFFFF" : "#6B7280",
            borderRadius: 4,
            textTransform: "uppercase",
            letterSpacing: 0.4,
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "6px 8px",
        fontSize: 12,
        color: "#6B7280",
        background: "#F9FAFB",
        border: "1px dashed #E5E7EB",
        borderRadius: 4,
      }}
    >
      {children}
    </div>
  );
}

// ── SaveIndicator ────────────────────────────────────────────────

function SaveIndicator({
  status,
}: {
  status: "saved" | "saving" | "unsaved";
}) {
  const cfg = {
    saved: { color: "#059669", text: "Saved" },
    saving: { color: "#6366F1", text: "Saving…" },
    unsaved: { color: "#D97706", text: "Unsaved" },
  }[status];
  return (
    <span style={{ fontSize: 11, color: cfg.color, fontWeight: 600 }}>
      {cfg.text}
    </span>
  );
}

// ── Shared input style ───────────────────────────────────────────
// Matches SpecTab's inputStyle exactly so the two tabs share visual
// vocabulary. Keep them in sync if either evolves.

const inputStyle: React.CSSProperties = {
  fontSize: 13,
  padding: "7px 10px",
  borderRadius: 6,
  border: "1px solid #D1D5DB",
  background: "#FFFFFF",
  fontFamily: "inherit",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

// ─────────────────────────────────────────────────────────────────
// Draft with AI — button + panel (pt.47)
// Mirror of SpecTab's DraftWithAiButton + SpecDraftPanel.
// ─────────────────────────────────────────────────────────────────

/**
 * Header-mounted button. Idle / error → "Draft with AI"; loading
 * shows a spinner-ish label and is disabled (cancel happens via the
 * panel itself); success keeps the button visible but inert because
 * the panel is the active surface.
 */
function DraftWithAiButton({
  phase,
  onClick,
}: {
  phase: DraftPhase;
  onClick: () => void;
}) {
  const isBusy = phase === "loading" || phase === "success";
  const label =
    phase === "loading"
      ? "Drafting…"
      : phase === "success"
        ? "Draft ready"
        : phase === "error"
          ? "Try draft again"
          : "✨ Draft with AI";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isBusy}
      title={
        phase === "loading"
          ? "Drafting in progress — see panel on the right"
          : phase === "success"
            ? "Draft ready — review in the right panel"
            : "Use the active LLM provider to draft a complete screens canvas"
      }
      style={{
        padding: "6px 14px",
        fontSize: 12,
        fontWeight: 600,
        background: isBusy ? "#EEF2FF" : "#4338CA",
        color: isBusy ? "#4338CA" : "#FFFFFF",
        border: "1px solid #4338CA",
        borderRadius: 6,
        cursor: isBusy ? "default" : "pointer",
        opacity: isBusy ? 0.85 : 1,
      }}
    >
      {label}
    </button>
  );
}

type ScreensDraftPanelProps = {
  phase: DraftPhase;
  draftCanvas: ScreensCanvas | null;
  error: string | null;
  providerDisplayName: string | null;
  model: string | null;
  /** Liveness-only — the panel ticks this up so the founder knows the
   *  stream is alive. */
  deltaCount: number;
  sectionStates: Partial<Record<DraftSectionId, SectionState>>;
  /** Used to resolve featureId/entityId references in the draft to
   *  human names for the preview. The drafter prompt instructs the
   *  model to use spec ids verbatim, so this resolution should
   *  succeed in the happy path. */
  specSnapshot: SpecSnapshot;
  onCancel: () => void;
  onRetry: () => void;
  onApplyAll: (mode: "replace" | "merge") => void;
  onApplyScreens: (mode: "replace" | "merge" | "skip") => void;
  onApplyNotes: (mode: "replace" | "skip") => void;
};

/**
 * Right-column panel for the AI draft flow. Replaces the must-haves
 * panel while a draft is open; the founder can Discard / Cancel to
 * close back to must-haves at any time.
 *
 * Layout mirror of SpecDraftPanel:
 *   - Sticky header: title, provider · model line, Close button.
 *   - Body switches on phase:
 *       loading → spinner + tick counter + Cancel
 *       error   → message + Retry / Close
 *       success → Apply-all controls + per-section trio rows
 */
function ScreensDraftPanel(props: ScreensDraftPanelProps) {
  const {
    phase,
    draftCanvas,
    error,
    providerDisplayName,
    model,
    deltaCount,
    sectionStates,
    specSnapshot,
    onCancel,
    onRetry,
    onApplyAll,
    onApplyScreens,
    onApplyNotes,
  } = props;

  // Build a screen-summary preview from the draft. We resolve
  // feature/entity ids to names where possible; raw ids fall through
  // when the spec snapshot is empty or the model invents ids that
  // don't exist (the latter is a soft warning we don't surface in
  // the panel — the founder will see them after applying).
  const screensPreview = (() => {
    if (!draftCanvas) return "(none)";
    const named = draftCanvas.screens.filter(
      (s) => s.name.trim().length > 0
    );
    if (named.length === 0) return "(none)";
    return named
      .slice(0, 5)
      .map((s) => `${SHELL_TYPE_LABELS[s.shellType]}: ${s.name}`)
      .join(" · ") + (named.length > 5 ? ` +${named.length - 5} more` : "");
  })();

  // Quick coverage hint: how many of the spec's Must features show up
  // in the draft's featureIds. Helpful for the founder — if the AI
  // missed a Must feature, they'll see "covers 4/5 Must features" and
  // know to merge + add the missing one rather than blind-replace.
  const mustCoverage = (() => {
    if (!draftCanvas) return null;
    const mustIds = specSnapshot.features
      .filter((f) => f.priority === "must" && f.name.trim().length > 0)
      .map((f) => f.id);
    if (mustIds.length === 0) return null;
    const covered = new Set<string>();
    for (const s of draftCanvas.screens) {
      for (const fid of s.featureIds) covered.add(fid);
    }
    const hits = mustIds.filter((id) => covered.has(id)).length;
    return { hits, total: mustIds.length };
  })();

  return (
    <aside
      style={{
        padding: 0,
        background: "#FFFFFF",
        border: "1px solid #C7D2FE",
        borderRadius: 8,
        alignSelf: "start",
        position: "sticky",
        top: 16,
        maxHeight: "calc(100vh - 32px)",
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* ── Header ─────────────────────────────────────────────── */}
      <div
        style={{
          padding: "12px 14px",
          borderBottom: "1px solid #E5E7EB",
          background: "#F5F3FF",
          position: "sticky",
          top: 0,
          zIndex: 1,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <h3
            style={{
              margin: 0,
              fontSize: 13,
              fontWeight: 700,
              color: "#3730A3",
            }}
          >
            ✨ AI Draft
          </h3>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: "2px 8px",
              fontSize: 11,
              background: "#FFFFFF",
              color: "#4338CA",
              border: "1px solid #C7D2FE",
              borderRadius: 4,
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            {phase === "loading" ? "Cancel" : "Close"}
          </button>
        </div>
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: "#4B5563",
          }}
        >
          {providerDisplayName && model
            ? `Drafting with ${providerDisplayName} · ${model}`
            : "Drafting with the active provider"}
          {phase === "success" && (
            <span style={{ color: "#6B7280" }}>
              {" "}— Replace overwrites the section, Merge appends.
            </span>
          )}
        </div>
      </div>

      {/* ── Body ───────────────────────────────────────────────── */}
      {phase === "loading" && (
        <div style={{ padding: 16, fontSize: 12, color: "#4B5563" }}>
          <div style={{ marginBottom: 8 }}>
            Drafting your screen inventory from spec + brand brief…
          </div>
          <div style={{ fontSize: 11, color: "#9CA3AF" }}>
            {deltaCount > 0
              ? `Streaming · ${deltaCount} chunks`
              : "Waiting for first token…"}
          </div>
          <div style={{ fontSize: 11, color: "#6B7280", marginTop: 12 }}>
            This usually takes 15–45 seconds depending on provider.
          </div>
        </div>
      )}

      {phase === "error" && (
        <div style={{ padding: 16, fontSize: 12, color: "#7F1D1D" }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            Couldn't complete the draft
          </div>
          <div
            style={{
              padding: 10,
              background: "#FEF2F2",
              border: "1px solid #FECACA",
              borderRadius: 6,
              color: "#991B1B",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {error ?? "Unknown error."}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              type="button"
              onClick={onRetry}
              style={{
                padding: "6px 12px",
                fontSize: 12,
                background: "#4338CA",
                color: "#FFFFFF",
                border: "1px solid #4338CA",
                borderRadius: 6,
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              Retry
            </button>
            <button
              type="button"
              onClick={onCancel}
              style={{
                padding: "6px 12px",
                fontSize: 12,
                background: "#FFFFFF",
                color: "#374151",
                border: "1px solid #D1D5DB",
                borderRadius: 6,
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}

      {phase === "success" && draftCanvas && (
        <div
          style={{
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {/* Apply-all conveniences */}
          <div
            style={{
              padding: 10,
              background: "#F9FAFB",
              border: "1px solid #E5E7EB",
              borderRadius: 6,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div style={{ fontSize: 11, color: "#6B7280", fontWeight: 600 }}>
              Apply all sections
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                onClick={() => onApplyAll("replace")}
                style={applyAllBtn("replace")}
              >
                Replace all
              </button>
              <button
                type="button"
                onClick={() => onApplyAll("merge")}
                style={applyAllBtn("merge")}
              >
                Merge all
              </button>
            </div>
          </div>

          {/* Coverage hint — only when there are Must features in the
              spec to cover. Empty spec → coverage is meaningless. */}
          {mustCoverage && (
            <div
              style={{
                padding: 8,
                background:
                  mustCoverage.hits === mustCoverage.total
                    ? "#ECFDF5"
                    : "#FFFBEB",
                border: `1px solid ${
                  mustCoverage.hits === mustCoverage.total
                    ? "#A7F3D0"
                    : "#FDE68A"
                }`,
                borderRadius: 6,
                fontSize: 11,
                color:
                  mustCoverage.hits === mustCoverage.total
                    ? "#065F46"
                    : "#92400E",
                fontWeight: 600,
              }}
            >
              Draft covers {mustCoverage.hits}/{mustCoverage.total} Must
              features
              {mustCoverage.hits < mustCoverage.total && (
                <span style={{ fontWeight: 500 }}>
                  {" "}— consider Merge + add the missing screens.
                </span>
              )}
            </div>
          )}

          <DraftSectionRow
            id="screens"
            label="Screens"
            preview={screensPreview}
            count={
              draftCanvas.screens.filter((s) => s.name.trim().length > 0).length
            }
            state={sectionStates.screens ?? "pending"}
            onAction={onApplyScreens}
          />

          <DraftSectionRow
            id="notes"
            label="Notes"
            preview={draftCanvas.notes || "(empty)"}
            count={draftCanvas.notes.trim().length > 0 ? 1 : 0}
            singleton
            state={sectionStates.notes ?? "pending"}
            onAction={(m) =>
              onApplyNotes(m === "merge" ? "replace" : (m as "replace" | "skip"))
            }
          />
        </div>
      )}
    </aside>
  );
}

function applyAllBtn(mode: "replace" | "merge"): React.CSSProperties {
  return {
    flex: 1,
    padding: "6px 10px",
    fontSize: 11,
    fontWeight: 600,
    background: mode === "replace" ? "#4338CA" : "#FFFFFF",
    color: mode === "replace" ? "#FFFFFF" : "#4338CA",
    border: "1px solid #4338CA",
    borderRadius: 4,
    cursor: "pointer",
  };
}

/**
 * Per-section row inside the draft panel. Same shape as SpecTab's
 * DraftSectionRow — kept inline (not extracted) so the two tabs can
 * evolve their preview rendering independently.
 */
function DraftSectionRow({
  label,
  preview,
  count,
  singleton = false,
  state,
  onAction,
}: {
  id: DraftSectionId;
  label: string;
  preview: string;
  count: number;
  singleton?: boolean;
  state: SectionState;
  onAction: (mode: "replace" | "merge" | "skip") => void;
}) {
  const isCommitted = state !== "pending";
  return (
    <div
      style={{
        padding: 10,
        background: isCommitted ? "#F9FAFB" : "#FFFFFF",
        border: "1px solid #E5E7EB",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        opacity: isCommitted ? 0.75 : 1,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "#111827",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {label}
          <span
            style={{
              fontSize: 10,
              padding: "1px 6px",
              borderRadius: 999,
              background: count > 0 ? "#E0E7FF" : "#F3F4F6",
              color: count > 0 ? "#3730A3" : "#9CA3AF",
              fontWeight: 600,
            }}
          >
            {count}
          </span>
        </div>
        {isCommitted && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              color:
                state === "skipped"
                  ? "#6B7280"
                  : state === "applied-merge"
                    ? "#0E7490"
                    : "#059669",
            }}
          >
            {state === "skipped"
              ? "Skipped"
              : state === "applied-merge"
                ? "✓ Merged"
                : "✓ Replaced"}
          </span>
        )}
      </div>
      <div
        style={{
          fontSize: 11,
          color: "#6B7280",
          lineHeight: 1.4,
          maxHeight: 72,
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "-webkit-box",
          WebkitLineClamp: 4,
          WebkitBoxOrient: "vertical",
        }}
      >
        {preview}
      </div>
      {!isCommitted && (
        <div style={{ display: "flex", gap: 4 }}>
          <button
            type="button"
            onClick={() => onAction("replace")}
            style={trioBtn("primary")}
          >
            Replace
          </button>
          {!singleton && (
            <button
              type="button"
              onClick={() => onAction("merge")}
              style={trioBtn("secondary")}
            >
              Merge
            </button>
          )}
          <button
            type="button"
            onClick={() => onAction("skip")}
            style={trioBtn("muted")}
          >
            Skip
          </button>
        </div>
      )}
    </div>
  );
}

function trioBtn(
  variant: "primary" | "secondary" | "muted"
): React.CSSProperties {
  if (variant === "primary") {
    return {
      flex: 1,
      padding: "5px 8px",
      fontSize: 11,
      fontWeight: 600,
      background: "#4338CA",
      color: "#FFFFFF",
      border: "1px solid #4338CA",
      borderRadius: 4,
      cursor: "pointer",
    };
  }
  if (variant === "secondary") {
    return {
      flex: 1,
      padding: "5px 8px",
      fontSize: 11,
      fontWeight: 600,
      background: "#FFFFFF",
      color: "#4338CA",
      border: "1px solid #C7D2FE",
      borderRadius: 4,
      cursor: "pointer",
    };
  }
  return {
    flex: 1,
    padding: "5px 8px",
    fontSize: 11,
    fontWeight: 600,
    background: "#FFFFFF",
    color: "#6B7280",
    border: "1px solid #E5E7EB",
    borderRadius: 4,
    cursor: "pointer",
  };
}
