import {
  type ApiEndpoint,
  type Entity,
  type EntityField,
  type FailedRunEntry,
  type Feature,
  type FeaturePriority,
  FeaturePrioritySchema,
  type HttpMethod,
  HttpMethodSchema,
  type Metric,
  type NonFunctionalCategory,
  NonFunctionalCategorySchema,
  type NonFunctionalRequirement,
  type Persona,
  type ProductSpecCanvas,
  ProductSpecCanvasSchema,
  type Venture,
  type VentureManifest,
  type VentureStage,
  createEmptyProductSpecCanvas,
  deriveProductSpecRules,
  isProductSpecComplete,
} from "@founder-os/domain";
import { getSpecCanvasPath } from "@founder-os/workspace-core";
import { invoke } from "@tauri-apps/api/core";
/**
 * SpecTab (pt.41) — guided UI for the SPEC_READY stage.
 *
 * Reads + writes `06_product/specs/spec-canvas.json` (the canvas
 * defined in @founder-os/domain/spec). The canvas captures the
 * structured product specification: purpose, personas, features,
 * scope, data model, API surface, non-functional requirements, and
 * success metrics.
 *
 * Pattern mirrors UkSetupTab (pt.33): debounced autosave, "Saved"
 * indicator, must-haves panel on the right driven by
 * `deriveProductSpecRules`. Eight sections — most are dynamic lists
 * (personas, features, entities, endpoints, NFRs, metrics) with
 * add/remove/reorder helpers.
 *
 * Saving is best-effort: a failed write surfaces a toast but doesn't
 * block further edits. The canvas debounce (~600ms idle) covers most
 * typing patterns. The pipeline step (ensure-spec) re-renders the
 * derived `product-spec.md` from the canvas on every run, so the
 * .md is read-only from the UI's perspective.
 */
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type AdvancePreflight, runAdvancePreflight } from "../../lib/advance-gate.js";
import { findLatestFailedRunForStage } from "../../lib/failed-runs.js";
import { runProductStage } from "../../lib/run-product-stage.js";
import { type DistilledSpecFields, distillSpec } from "../../lib/spec-distiller.js";
import { type SpecDraftResult, draftSpecCanvas } from "../../lib/spec-drafter.js";
import { pushToast } from "../../lib/toasts.js";
import { AdvanceConfirmModal } from "./AdvanceConfirmModal.js";
import { DistillDiffModal, type DistillFieldConfig, distillTextField } from "./DistillDiffModal.js";
import { FailedRunBanner } from "./FailedRunBanner.js";

const SAVE_DEBOUNCE_MS = 600;

// ─────────────────────────────────────────────────────────────────
// Draft panel state machine (pt.42a)
// ─────────────────────────────────────────────────────────────────

/** Phase of the AI draft flow. `idle` = panel closed, no draft attempt
 *  yet; `loading` = streaming from the provider; `success` = canvas
 *  ready for per-section apply; `error` = surfaced to the panel as a
 *  retryable message. */
type DraftPhase = "idle" | "loading" | "success" | "error";

/** Per-section apply state shown in the panel as the founder commits
 *  (or skips) each section of the AI draft. `pending` is the initial
 *  state. */
type SectionState = "pending" | "applied-replace" | "applied-merge" | "skipped";

/** Section ids the panel cycles through. Matches the SpecTab section
 *  numbering 1..8 + Notes. Scope is one row covering both inScope +
 *  outOfScope (replace replaces both, merge appends both). */
type DraftSectionId =
  | "purpose"
  | "personas"
  | "features"
  | "scope"
  | "entities"
  | "endpoints"
  | "nfrs"
  | "metrics"
  | "notes";

type Props = {
  venture: Venture;
  manifest: VentureManifest | null;
  /** Optional: when present, the header shows an "Advance" button that
   *  runs the pre-flight audit and gates the SPEC_READY transition. */
  onAdvanceStage?: (stage: VentureStage) => void;
};

// ─────────────────────────────────────────────────────────────────
// Distill field config (text-shaped subset of ProductSpecCanvas)
// ─────────────────────────────────────────────────────────────────

function renderStringList(value: unknown): React.ReactNode {
  if (!Array.isArray(value) || value.length === 0) {
    return <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>(empty)</span>;
  }
  return (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {(value as unknown[]).map((entry, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static list, order does not change
        <li key={`spec-list-${i}`} style={{ marginBottom: 4 }}>
          {typeof entry === "string" ? entry : JSON.stringify(entry)}
        </li>
      ))}
    </ul>
  );
}

function stringListEquals(current: unknown, proposed: unknown): boolean {
  const a = (Array.isArray(current) ? current : []) as unknown[];
  const b = (Array.isArray(proposed) ? proposed : []) as unknown[];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = typeof a[i] === "string" ? (a[i] as string).trim() : "";
    const bi = typeof b[i] === "string" ? (b[i] as string).trim() : "";
    if (ai !== bi) return false;
  }
  return true;
}

const SPEC_DISTILL_FIELDS: DistillFieldConfig[] = [
  distillTextField("purpose", "Purpose"),
  {
    key: "inScope",
    label: "In scope (v1)",
    render: renderStringList,
    equals: stringListEquals,
  },
  {
    key: "outOfScope",
    label: "Out of scope",
    render: renderStringList,
    equals: stringListEquals,
  },
  distillTextField("notes", "Notes"),
];

// ─────────────────────────────────────────────────────────────────
// ID helpers
// ─────────────────────────────────────────────────────────────────

/**
 * Stable id for sub-objects (personas, features, entities, etc.).
 * crypto.randomUUID() everywhere it's available; fall back to a
 * timestamp + random tail if not (older WebViews / non-secure
 * contexts). Collision risk is negligible at canvas scale.
 */
function newId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function SpecTab({ venture, manifest, onAdvanceStage }: Props) {
  const canvasPath = useMemo(() => getSpecCanvasPath(venture.rootPath), [venture.rootPath]);

  const [canvas, setCanvas] = useState<ProductSpecCanvas | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "unsaved">("saved");

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydratedRef = useRef(false);

  // Draft panel state (pt.42a) — separate from saveStatus so a stalled
  // draft never blocks autosave of the founder's existing edits.
  const [draftPhase, setDraftPhase] = useState<DraftPhase>("idle");
  const [draftCanvas, setDraftCanvas] = useState<ProductSpecCanvas | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftProvider, setDraftProvider] = useState<string | null>(null);
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [sectionStates, setSectionStates] = useState<Partial<Record<DraftSectionId, SectionState>>>(
    {}
  );
  /** Token-pulse counter just for showing liveness during streaming.
   *  We don't render partial JSON; this is a heartbeat the panel reads
   *  to animate the spinner label. */
  const [draftDeltaCount, setDraftDeltaCount] = useState(0);
  const draftAbortRef = useRef<AbortController | null>(null);

  // Distill from chat + docs — orthogonal to the AI Draft flow above.
  // Distill targets only the free-text fields; structured rows are
  // owned by `draftSpecCanvas`.
  const [distilling, setDistilling] = useState(false);
  const [distillDraft, setDistillDraft] = useState<DistilledSpecFields | null>(null);

  // Advance-stage gate (pre-flight audit). `advancing` toggles the button
  // spinner; `advanceModal` holds the preflight result while the
  // AdvanceConfirmModal is open.
  const [advancing, setAdvancing] = useState(false);
  // Stage-runner adoption: PRODUCT_SPEC stage. Both SpecTab and
  // ScreensTab share this stage so the failed-run banner reflects
  // whichever tab last triggered a run.
  const [runningProductStage, setRunningProductStage] = useState(false);
  const [failedProductRun, setFailedProductRun] = useState<FailedRunEntry | null>(null);
  const [advanceModal, setAdvanceModal] = useState<AdvancePreflight | null>(null);

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

  // Reset the draft panel when the founder switches venture — a draft
  // for venture A shouldn't survive into venture B's view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally omitted
  useEffect(() => {
    resetDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venture.id]);

  // Load on mount / venture switch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      hydratedRef.current = false;
      try {
        const exists = await invoke<boolean>("path_exists", { path: canvasPath });
        if (exists) {
          const raw = await invoke<string>("read_file", { path: canvasPath });
          const parsed = ProductSpecCanvasSchema.safeParse(JSON.parse(raw));
          if (parsed.success) {
            if (!cancelled) setCanvas(parsed.data);
          } else {
            // File on disk is malformed — start with a fresh canvas
            // but don't overwrite. The audit's same-day tripwire
            // picks this up too.
            console.warn("[spec] canvas parse failed, using fresh defaults", parsed.error);
            if (!cancelled) setCanvas(createEmptyProductSpecCanvas(venture.id));
          }
        } else {
          // No canvas on disk yet — happens before the first pipeline
          // run. Initialise so the user can edit immediately; the
          // autosave will create the file.
          if (!cancelled) setCanvas(createEmptyProductSpecCanvas(venture.id));
        }
      } catch (err) {
        console.error("[spec] load failed", err);
        if (!cancelled) setCanvas(createEmptyProductSpecCanvas(venture.id));
      } finally {
        if (!cancelled) setLoading(false);
        hydratedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canvasPath, venture.id]);

  // Autosave on canvas change.
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
          content: `${JSON.stringify(next, null, 2)}\n`,
        });
        setSaveStatus("saved");
      } catch (err) {
        console.error("[spec] save failed", err);
        pushToast({
          kind: "error",
          message: "Couldn't save Spec canvas",
          detail: err instanceof Error ? err.message : String(err),
        });
        setSaveStatus("unsaved");
      }
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [canvas, canvasPath]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally omitted
  // Failed-run lookup. Lives above the early return so the hook order
  // is stable -- the loading/canvas/manifest gate flips between
  // renders and React's rules-of-hooks tripped when this useEffect was
  // below the early return.
  useEffect(() => {
    let cancelled = false;
    findLatestFailedRunForStage(venture.rootPath, "PRODUCT_SPEC")
      .then((entry) => {
        if (!cancelled) setFailedProductRun(entry);
      })
      .catch(() => {
        if (!cancelled) setFailedProductRun(null);
      });
    return () => {
      cancelled = true;
    };
  }, [venture.rootPath, runningProductStage]);

  if (loading || !canvas || !manifest) {
    return <div style={{ padding: 28, color: "var(--text-tertiary)" }}>Loading Spec canvas…</div>;
  }

  const rules = deriveProductSpecRules(canvas);
  const passCount = rules.filter((r) => r.pass).length;
  const specComplete = isProductSpecComplete(canvas);

  // ─────────────────────────────────────────────────────────────
  // Advance-stage handlers (pre-flight audit gate)
  // ─────────────────────────────────────────────────────────────
  const commitAdvance = () => {
    if (!onAdvanceStage) return;
    onAdvanceStage("SPEC_READY");
    pushToast({ kind: "success", message: "Advanced to Spec Ready", ttlMs: 3000 });
    setAdvanceModal(null);
    setAdvancing(false);
  };

  // Run the PRODUCT_SPEC stage via @founder-os/stage-runners. The
  // runner has no LLM dependency (all three steps are deterministic
  // and idempotent), so this works regardless of provider config.
  const handleRunProductStage = async () => {
    if (runningProductStage) return;
    if (!manifest) {
      pushToast({
        kind: "warn",
        message: "Venture manifest hasn't loaded yet -- try again in a moment",
        ttlMs: 5000,
      });
      return;
    }
    setRunningProductStage(true);
    pushToast({
      kind: "info",
      message: "Running product stage (brief + spec + screens)...",
      detail: "3 deterministic steps via ProductStageRunner. Existing files are skipped.",
      ttlMs: 4000,
    });
    try {
      const out = await runProductStage({ venture, manifest });
      const { result, steps } = out;
      if (result.success) {
        const done = [
          steps.brief === "ok" ? "brief" : null,
          steps.spec === "ok" ? "spec" : null,
          steps.screens === "ok" ? "screens" : null,
        ].filter(Boolean) as string[];
        pushToast({
          kind: "success",
          message: `Product stage complete (${done.length}/3)`,
          detail: done.length
            ? `Steps: ${done.join(", ")}. Saved under 06_product/.`
            : "Stage already complete -- no work to do.",
          ttlMs: 8000,
        });
      } else {
        pushToast({
          kind: "error",
          message: "Product stage failed",
          detail: result.error?.message ?? "Unknown error",
        });
      }
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Couldn't run product stage",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunningProductStage(false);
    }
  };

  // (failed-run lookup useEffect moved above the early return -- see
  // the note up there. Keeping this comment so future-me doesn't try
  // to re-add it here and reintroduce the rules-of-hooks violation.)

  const handleAdvance = async () => {
    if (!onAdvanceStage || !specComplete || advancing) return;
    setAdvancing(true);
    try {
      const preflight = await runAdvancePreflight({
        ventureId: venture.id,
        ventureRoot: venture.rootPath,
        nextStage: "SPEC_READY",
        manifest,
      });
      if (preflight.blockers.length === 0 && preflight.warnings.length === 0) {
        commitAdvance();
        return;
      }
      setAdvanceModal(preflight);
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Pre-flight audit failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      commitAdvance();
      return;
    }
    setAdvancing(false);
  };

  // ─────────────────────────────────────────────────────────────
  // Update helpers
  // ─────────────────────────────────────────────────────────────

  const update = <K extends keyof ProductSpecCanvas>(key: K, value: ProductSpecCanvas[K]) =>
    setCanvas((cur) => (cur ? { ...cur, [key]: value } : cur));

  // ─────────────────────────────────────────────────────────────
  // Distill from chat + docs
  // ─────────────────────────────────────────────────────────────
  const handleDistill = async () => {
    if (distilling || !canvas) return;
    setDistilling(true);
    try {
      const draft = await distillSpec({
        ventureId: venture.id,
        stage: venture.stage,
        ventureRootPath: venture.rootPath,
        currentFields: {
          purpose: canvas.purpose,
          inScope: canvas.inScope,
          outOfScope: canvas.outOfScope,
          notes: canvas.notes,
        },
      });
      if (Object.keys(draft).length === 0) {
        pushToast({
          kind: "warn",
          message: "Nothing to distill yet",
          detail: "No chat history or text-shaped docs found in the venture folder.",
          ttlMs: 5000,
        });
        return;
      }
      setDistillDraft(draft);
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Distill failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDistilling(false);
    }
  };

  const handleApplyDistill = (selected: Record<string, unknown>) => {
    if (Object.keys(selected).length === 0 || !canvas) {
      setDistillDraft(null);
      return;
    }
    let applied = 0;
    if (typeof selected.purpose === "string") {
      update("purpose", selected.purpose);
      applied++;
    }
    if (typeof selected.notes === "string") {
      update("notes", selected.notes);
      applied++;
    }
    if (Array.isArray(selected.inScope)) {
      update(
        "inScope",
        (selected.inScope as unknown[]).filter((e): e is string => typeof e === "string")
      );
      applied++;
    }
    if (Array.isArray(selected.outOfScope)) {
      update(
        "outOfScope",
        (selected.outOfScope as unknown[]).filter((e): e is string => typeof e === "string")
      );
      applied++;
    }
    if (applied > 0) {
      pushToast({
        kind: "success",
        message: `✨ Applied ${applied} distilled field${applied === 1 ? "" : "s"}`,
        ttlMs: 4000,
      });
    }
    setDistillDraft(null);
  };

  // Generic list editors — each section's list-of-objects pattern
  // boils down to "replace the whole list" via setCanvas. The
  // helpers below are thin convenience wrappers; pulling them out
  // keeps the JSX readable.

  const updatePersona = (id: string, patch: Partial<Persona>) =>
    setCanvas((cur) =>
      cur
        ? {
            ...cur,
            personas: cur.personas.map((p) => (p.id === id ? { ...p, ...patch } : p)),
          }
        : cur
    );
  const addPersona = () =>
    setCanvas((cur) =>
      cur
        ? {
            ...cur,
            personas: [
              ...cur.personas,
              {
                id: newId("persona"),
                name: "",
                description: "",
                painPoints: [],
                primaryGoal: "",
              },
            ],
          }
        : cur
    );
  const removePersona = (id: string) =>
    setCanvas((cur) => (cur ? { ...cur, personas: cur.personas.filter((p) => p.id !== id) } : cur));

  const updateFeature = (id: string, patch: Partial<Feature>) =>
    setCanvas((cur) =>
      cur
        ? {
            ...cur,
            features: cur.features.map((f) => (f.id === id ? { ...f, ...patch } : f)),
          }
        : cur
    );
  const addFeature = () =>
    setCanvas((cur) =>
      cur
        ? {
            ...cur,
            features: [
              ...cur.features,
              {
                id: newId("feature"),
                name: "",
                description: "",
                priority: "must" as FeaturePriority,
                acceptanceCriteria: [],
                personaId: "",
              },
            ],
          }
        : cur
    );
  const removeFeature = (id: string) =>
    setCanvas((cur) => (cur ? { ...cur, features: cur.features.filter((f) => f.id !== id) } : cur));

  const updateEntity = (id: string, patch: Partial<Entity>) =>
    setCanvas((cur) =>
      cur
        ? {
            ...cur,
            dataModel: {
              ...cur.dataModel,
              entities: cur.dataModel.entities.map((e) => (e.id === id ? { ...e, ...patch } : e)),
            },
          }
        : cur
    );
  const addEntity = () =>
    setCanvas((cur) =>
      cur
        ? {
            ...cur,
            dataModel: {
              ...cur.dataModel,
              entities: [
                ...cur.dataModel.entities,
                {
                  id: newId("entity"),
                  name: "",
                  description: "",
                  fields: [],
                },
              ],
            },
          }
        : cur
    );
  const removeEntity = (id: string) =>
    setCanvas((cur) =>
      cur
        ? {
            ...cur,
            dataModel: {
              ...cur.dataModel,
              entities: cur.dataModel.entities.filter((e) => e.id !== id),
            },
          }
        : cur
    );

  const updateEndpoint = (id: string, patch: Partial<ApiEndpoint>) =>
    setCanvas((cur) =>
      cur
        ? {
            ...cur,
            apiSurface: {
              ...cur.apiSurface,
              endpoints: cur.apiSurface.endpoints.map((e) =>
                e.id === id ? { ...e, ...patch } : e
              ),
            },
          }
        : cur
    );
  const addEndpoint = () =>
    setCanvas((cur) =>
      cur
        ? {
            ...cur,
            apiSurface: {
              ...cur.apiSurface,
              endpoints: [
                ...cur.apiSurface.endpoints,
                {
                  id: newId("endpoint"),
                  method: "GET" as HttpMethod,
                  path: "",
                  description: "",
                  requestNotes: "",
                  responseNotes: "",
                },
              ],
            },
          }
        : cur
    );
  const removeEndpoint = (id: string) =>
    setCanvas((cur) =>
      cur
        ? {
            ...cur,
            apiSurface: {
              ...cur.apiSurface,
              endpoints: cur.apiSurface.endpoints.filter((e) => e.id !== id),
            },
          }
        : cur
    );

  const updateNfr = (id: string, patch: Partial<NonFunctionalRequirement>) =>
    setCanvas((cur) =>
      cur
        ? {
            ...cur,
            nonFunctional: cur.nonFunctional.map((n) => (n.id === id ? { ...n, ...patch } : n)),
          }
        : cur
    );
  const addNfr = () =>
    setCanvas((cur) =>
      cur
        ? {
            ...cur,
            nonFunctional: [
              ...cur.nonFunctional,
              {
                id: newId("nfr"),
                category: "performance" as NonFunctionalCategory,
                description: "",
                target: "",
              },
            ],
          }
        : cur
    );
  const removeNfr = (id: string) =>
    setCanvas((cur) =>
      cur ? { ...cur, nonFunctional: cur.nonFunctional.filter((n) => n.id !== id) } : cur
    );

  const updateMetric = (id: string, patch: Partial<Metric>) =>
    setCanvas((cur) =>
      cur
        ? {
            ...cur,
            metrics: cur.metrics.map((m) => (m.id === id ? { ...m, ...patch } : m)),
          }
        : cur
    );
  const addMetric = () =>
    setCanvas((cur) =>
      cur
        ? {
            ...cur,
            metrics: [
              ...cur.metrics,
              { id: newId("metric"), name: "", target: "", currentBaseline: "" },
            ],
          }
        : cur
    );
  const removeMetric = (id: string) =>
    setCanvas((cur) => (cur ? { ...cur, metrics: cur.metrics.filter((m) => m.id !== id) } : cur));

  // ─────────────────────────────────────────────────────────────
  // Draft flow (pt.42a)
  // ─────────────────────────────────────────────────────────────

  /** Kick off an AI draft. Reuses the panel state machine — calling
   *  this while a draft is already in flight aborts the old one first
   *  so we don't end up with two streams writing into the same state. */
  const startDraft = async () => {
    if (!manifest) {
      pushToast({
        kind: "error",
        message: "Can't draft yet",
        detail: "Venture manifest hasn't loaded.",
      });
      return;
    }
    // Abort any in-flight attempt before starting a new one.
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

    let result: SpecDraftResult;
    try {
      result = await draftSpecCanvas({
        venture,
        manifest,
        signal: controller.signal,
        onDelta: () => setDraftDeltaCount((c) => c + 1),
      });
    } catch (err) {
      // draftSpecCanvas catches its own errors and returns them as
      // {ok:false}; this catch is just paranoia for an unexpected throw
      // (e.g. a missed import-time failure). Treat it the same way.
      result = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // If the user already moved on (closed the panel, switched venture)
    // the abort controller will have been cleared. Bail rather than
    // stomp over a fresh state.
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

  /** Singleton-section apply. Purpose + Notes use this — they have no
   *  meaningful "merge" (you can't append paragraphs without producing
   *  Frankenstein prose), so the panel only offers Replace / Skip. */
  const applyPurpose = (mode: "replace" | "skip") => {
    if (!draftCanvas) return;
    if (mode === "replace") update("purpose", draftCanvas.purpose);
    stampSection("purpose", mode === "replace" ? "applied-replace" : "skipped");
  };
  const applyNotes = (mode: "replace" | "skip") => {
    if (!draftCanvas) return;
    if (mode === "replace") update("notes", draftCanvas.notes);
    stampSection("notes", mode === "replace" ? "applied-replace" : "skipped");
  };

  /** List-section apply. Replace overwrites; Merge appends. We don't
   *  dedupe by id on merge — the AI's ids are random enough that
   *  collisions with the founder's existing list are statistically
   *  negligible, and de-duping by name would be too aggressive (the
   *  founder may want both their persona and the AI's similarly-named
   *  one to compare). */
  const applyPersonas = (mode: "replace" | "merge" | "skip") => {
    if (!draftCanvas) return;
    setCanvas((cur) => {
      if (!cur) return cur;
      if (mode === "replace") return { ...cur, personas: draftCanvas.personas };
      if (mode === "merge") return { ...cur, personas: [...cur.personas, ...draftCanvas.personas] };
      return cur;
    });
    stampSection(
      "personas",
      mode === "skip" ? "skipped" : mode === "replace" ? "applied-replace" : "applied-merge"
    );
  };

  const applyFeatures = (mode: "replace" | "merge" | "skip") => {
    if (!draftCanvas) return;
    setCanvas((cur) => {
      if (!cur) return cur;
      if (mode === "replace") return { ...cur, features: draftCanvas.features };
      if (mode === "merge") return { ...cur, features: [...cur.features, ...draftCanvas.features] };
      return cur;
    });
    stampSection(
      "features",
      mode === "skip" ? "skipped" : mode === "replace" ? "applied-replace" : "applied-merge"
    );
  };

  /** Scope is two lists rendered as one row. Replace replaces both;
   *  Merge appends to both. This keeps the panel UX a single trio per
   *  section instead of two for what founders typically think of as
   *  one thing ("scope"). */
  const applyScope = (mode: "replace" | "merge" | "skip") => {
    if (!draftCanvas) return;
    setCanvas((cur) => {
      if (!cur) return cur;
      if (mode === "replace")
        return {
          ...cur,
          inScope: draftCanvas.inScope,
          outOfScope: draftCanvas.outOfScope,
        };
      if (mode === "merge")
        return {
          ...cur,
          inScope: [...cur.inScope, ...draftCanvas.inScope],
          outOfScope: [...cur.outOfScope, ...draftCanvas.outOfScope],
        };
      return cur;
    });
    stampSection(
      "scope",
      mode === "skip" ? "skipped" : mode === "replace" ? "applied-replace" : "applied-merge"
    );
  };

  const applyEntities = (mode: "replace" | "merge" | "skip") => {
    if (!draftCanvas) return;
    setCanvas((cur) => {
      if (!cur) return cur;
      if (mode === "replace")
        return {
          ...cur,
          dataModel: { ...cur.dataModel, entities: draftCanvas.dataModel.entities },
        };
      if (mode === "merge")
        return {
          ...cur,
          dataModel: {
            ...cur.dataModel,
            entities: [...cur.dataModel.entities, ...draftCanvas.dataModel.entities],
          },
        };
      return cur;
    });
    stampSection(
      "entities",
      mode === "skip" ? "skipped" : mode === "replace" ? "applied-replace" : "applied-merge"
    );
  };

  const applyEndpoints = (mode: "replace" | "merge" | "skip") => {
    if (!draftCanvas) return;
    setCanvas((cur) => {
      if (!cur) return cur;
      if (mode === "replace")
        return {
          ...cur,
          apiSurface: {
            ...cur.apiSurface,
            endpoints: draftCanvas.apiSurface.endpoints,
          },
        };
      if (mode === "merge")
        return {
          ...cur,
          apiSurface: {
            ...cur.apiSurface,
            endpoints: [...cur.apiSurface.endpoints, ...draftCanvas.apiSurface.endpoints],
          },
        };
      return cur;
    });
    stampSection(
      "endpoints",
      mode === "skip" ? "skipped" : mode === "replace" ? "applied-replace" : "applied-merge"
    );
  };

  const applyNfrs = (mode: "replace" | "merge" | "skip") => {
    if (!draftCanvas) return;
    setCanvas((cur) => {
      if (!cur) return cur;
      if (mode === "replace") return { ...cur, nonFunctional: draftCanvas.nonFunctional };
      if (mode === "merge")
        return {
          ...cur,
          nonFunctional: [...cur.nonFunctional, ...draftCanvas.nonFunctional],
        };
      return cur;
    });
    stampSection(
      "nfrs",
      mode === "skip" ? "skipped" : mode === "replace" ? "applied-replace" : "applied-merge"
    );
  };

  const applyMetrics = (mode: "replace" | "merge" | "skip") => {
    if (!draftCanvas) return;
    setCanvas((cur) => {
      if (!cur) return cur;
      if (mode === "replace") return { ...cur, metrics: draftCanvas.metrics };
      if (mode === "merge") return { ...cur, metrics: [...cur.metrics, ...draftCanvas.metrics] };
      return cur;
    });
    stampSection(
      "metrics",
      mode === "skip" ? "skipped" : mode === "replace" ? "applied-replace" : "applied-merge"
    );
  };

  /** Convenience: apply every section in one mode. Singleton sections
   *  treat "merge" the same as "replace" since merging prose is
   *  meaningless. We post a toast so the founder gets immediate
   *  confirmation rather than scanning eight section stamps. */
  const applyAll = (mode: "replace" | "merge") => {
    if (!draftCanvas) return;
    applyPurpose("replace");
    applyPersonas(mode);
    applyFeatures(mode);
    applyScope(mode);
    applyEntities(mode);
    applyEndpoints(mode);
    applyNfrs(mode);
    applyMetrics(mode);
    applyNotes("replace");
    pushToast({
      kind: "success",
      message: `Applied AI draft (${mode})`,
      detail:
        mode === "replace"
          ? "All sections replaced from the draft."
          : "Lists merged with the draft; purpose / notes replaced.",
    });
  };

  // ─────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────

  return (
    // Outer scrolling panel mirrors BrandTab's working layout: the
    // VentureDashboard tab-content wrapper is `flex: 1, overflow: hidden`,
    // so each tab has to provide its own height/overflow. Without the
    // outer panel, percentage heights on children don't resolve and the
    // rainbow theme's conic-gradient paints through the grid gaps.
    //
    // data-fos-panel + bg-panel: under the rainbow theme this gets the
    // frosted-glass backdrop-filter (selector lives in styles/themes.css).
    // Under dark/grey themes it's just a normal panel background.
    <div
      data-fos-panel
      style={{
        height: "100%",
        overflow: "auto",
        background: "var(--bg-panel)",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          padding: 28,
          display: "grid",
          gridTemplateColumns: "1fr 320px",
          gap: 24,
        }}
      >
      {failedProductRun && (
        <FailedRunBanner
          label="product"
          entry={failedProductRun}
          ventureRoot={venture.rootPath}
          busy={runningProductStage}
          disabled={!manifest}
          onRetry={handleRunProductStage}
          gridSpan
        />
      )}
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
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>
              Product Spec
            </h2>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-tertiary)" }}>
              Purpose → personas → features → scope → data model → API → NFRs → metrics. Saved to{" "}
              <code>06_product/specs/spec-canvas.json</code>; markdown view re-rendered on each
              pipeline run.
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <SaveIndicator status={saveStatus} />
            <button
              type="button"
              onClick={handleDistill}
              disabled={distilling}
              title="Distill your chat history + uploaded docs into draft Spec free-text fields"
              style={{
                padding: "8px 14px",
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: distilling ? "var(--bg-elevated)" : "var(--accent-soft)",
                border: `1px solid ${distilling ? "var(--border-subtle)" : "var(--accent-soft)"}`,
                color: distilling ? "var(--text-muted)" : "var(--accent-hover)",
                borderRadius: 6,
                fontWeight: 600,
                fontSize: 13,
                cursor: distilling ? "not-allowed" : "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <span>{distilling ? "⏳" : "✨"}</span>
              {distilling ? "Distilling…" : "Distill from chat + docs"}
            </button>
            <DraftWithAiButton
              phase={draftPhase}
              onClick={() => {
                if (draftPhase === "idle" || draftPhase === "error") {
                  void startDraft();
                }
              }}
            />
            <button
              type="button"
              onClick={handleRunProductStage}
              disabled={runningProductStage || !manifest}
              title="Run brief + spec + screens via ProductStageRunner (failed-runs index, idempotent)"
              style={{
                padding: "8px 14px",
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: runningProductStage ? "var(--bg-elevated)" : "var(--accent-soft)",
                border: `1px solid ${runningProductStage ? "var(--border-subtle)" : "var(--accent-soft)"}`,
                color: runningProductStage ? "var(--text-muted)" : "var(--accent-hover)",
                borderRadius: 6,
                fontWeight: 600,
                fontSize: 13,
                cursor: runningProductStage || !manifest ? "not-allowed" : "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {runningProductStage ? "Running stage..." : "Run product stage"}
            </button>
            {onAdvanceStage && (
              <button
                type="button"
                onClick={handleAdvance}
                disabled={!specComplete || advancing}
                title={
                  specComplete
                    ? "Run pre-flight audit and advance to Spec Ready"
                    : `${passCount}/${rules.length} must-haves complete — finish the checklist`
                }
                style={{
                  padding: "8px 16px",
                  background: specComplete ? "var(--accent)" : "var(--border-subtle)",
                  color: specComplete ? "var(--bg-panel)" : "var(--text-muted)",
                  border: "none",
                  borderRadius: 6,
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: specComplete && !advancing ? "pointer" : "not-allowed",
                  whiteSpace: "nowrap",
                }}
              >
                {advancing ? "Checking…" : "Advance to Spec Ready →"}
              </button>
            )}
          </div>
        </div>

        {/* 1. Purpose ───────────────────────────────────────────── */}
        <Section title="1. Purpose" icon="🎯">
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-tertiary)" }}>
            One paragraph: what does this product do, for whom, and why does it matter? Specific
            noun, specific verb, specific outcome.
          </p>
          <textarea
            value={canvas.purpose}
            onChange={(e) => update("purpose", e.target.value)}
            placeholder="Helps solo SaaS founders track which features early customers ask about most, so they can prioritise the next month's build."
            rows={3}
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </Section>

        {/* 2. Personas ──────────────────────────────────────────── */}
        <Section title="2. Personas" icon="👥">
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-tertiary)" }}>
            Who are you building this for? Push for one primary persona at v1. Real pain points,
            real goals.
          </p>
          {canvas.personas.map((p) => (
            <PersonaCard
              key={p.id}
              persona={p}
              onChange={(patch) => updatePersona(p.id, patch)}
              onRemove={() => removePersona(p.id)}
            />
          ))}
          <AddRowButton label="+ Add persona" onClick={addPersona} />
        </Section>

        {/* 3. Features ──────────────────────────────────────────── */}
        <Section title="3. Features" icon="⚙️">
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-tertiary)" }}>
            MoSCoW-prioritised. Every Must-have feature needs at least one acceptance criterion — a
            checkable statement.
          </p>
          {canvas.features.map((f) => (
            <FeatureCard
              key={f.id}
              feature={f}
              personas={canvas.personas}
              onChange={(patch) => updateFeature(f.id, patch)}
              onRemove={() => removeFeature(f.id)}
            />
          ))}
          <AddRowButton label="+ Add feature" onClick={addFeature} />
        </Section>

        {/* 4. Scope ─────────────────────────────────────────────── */}
        <Section title="4. Scope" icon="🪟">
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-tertiary)" }}>
            Explicit in/out-of-scope statements reduce ambiguity at handoff.
          </p>
          <Field label="In scope (one per line)">
            <textarea
              value={canvas.inScope.join("\n")}
              onChange={(e) =>
                update(
                  "inScope",
                  e.target.value
                    .split("\n")
                    .map((s) => s)
                    .filter((s, i, arr) => i < arr.length - 1 || s.length > 0)
                )
              }
              placeholder={"Mobile-web responsive\nExports to CSV\nGoogle SSO"}
              rows={4}
              style={{ ...inputStyle, resize: "vertical" }}
            />
          </Field>
          <Field label="Out of scope (one per line)">
            <textarea
              value={canvas.outOfScope.join("\n")}
              onChange={(e) =>
                update(
                  "outOfScope",
                  e.target.value
                    .split("\n")
                    .map((s) => s)
                    .filter((s, i, arr) => i < arr.length - 1 || s.length > 0)
                )
              }
              placeholder={"Native mobile app\nMulti-tenancy\nAudit logs"}
              rows={4}
              style={{ ...inputStyle, resize: "vertical" }}
            />
          </Field>
        </Section>

        {/* 5. Data Model ────────────────────────────────────────── */}
        <Section title="5. Data Model" icon="🗄️">
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-tertiary)" }}>
            Entities and their fields. 3-7 entities is typical for an MVP; more than 10 needs
            justification.
          </p>
          {canvas.dataModel.entities.map((e) => (
            <EntityCard
              key={e.id}
              entity={e}
              onChange={(patch) => updateEntity(e.id, patch)}
              onRemove={() => removeEntity(e.id)}
            />
          ))}
          <AddRowButton label="+ Add entity" onClick={addEntity} />
        </Section>

        {/* 6. API Surface ───────────────────────────────────────── */}
        <Section title="6. API Surface" icon="🔌">
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-tertiary)" }}>
            REST or RPC-style endpoints. Method + path + description; notes for non-obvious shapes.
          </p>
          {canvas.apiSurface.endpoints.map((ep) => (
            <EndpointCard
              key={ep.id}
              endpoint={ep}
              onChange={(patch) => updateEndpoint(ep.id, patch)}
              onRemove={() => removeEndpoint(ep.id)}
            />
          ))}
          <AddRowButton label="+ Add endpoint" onClick={addEndpoint} />
        </Section>

        {/* 7. Non-functional Requirements ───────────────────────── */}
        <Section title="7. Non-functional Requirements" icon="🛡️">
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-tertiary)" }}>
            Performance, security, accessibility, compliance. Pick the few that actually matter;
            each needs a measurable target.
          </p>
          {canvas.nonFunctional.map((n) => (
            <NfrCard
              key={n.id}
              nfr={n}
              onChange={(patch) => updateNfr(n.id, patch)}
              onRemove={() => removeNfr(n.id)}
            />
          ))}
          <AddRowButton label="+ Add NFR" onClick={addNfr} />
        </Section>

        {/* 8. Success Metrics ───────────────────────────────────── */}
        <Section title="8. Success Metrics" icon="📈">
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-tertiary)" }}>
            How will you know v1 is working? Avoid vanity metrics (signups, page views) without
            conversion gating.
          </p>
          {canvas.metrics.map((m) => (
            <MetricCard
              key={m.id}
              metric={m}
              onChange={(patch) => updateMetric(m.id, patch)}
              onRemove={() => removeMetric(m.id)}
            />
          ))}
          <AddRowButton label="+ Add metric" onClick={addMetric} />
        </Section>

        {/* Notes ────────────────────────────────────────────────── */}
        <Section title="Notes" icon="🗒️">
          <textarea
            value={canvas.notes}
            onChange={(e) => update("notes", e.target.value)}
            placeholder="Anything that doesn't fit the structured fields…"
            rows={4}
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </Section>
      </div>

      {/* ── Right column: Draft panel (when active) or Must-haves ── */}
      {draftPhase !== "idle" ? (
        <SpecDraftPanel
          phase={draftPhase}
          draftCanvas={draftCanvas}
          error={draftError}
          providerDisplayName={draftProvider}
          model={draftModel}
          deltaCount={draftDeltaCount}
          sectionStates={sectionStates}
          onCancel={() => {
            // Cancel-during-loading: abort + return to idle.
            // Close-after-success: same path; the user can re-draft.
            resetDraft();
          }}
          onRetry={() => void startDraft()}
          onApplyAll={applyAll}
          onApplyPurpose={applyPurpose}
          onApplyPersonas={applyPersonas}
          onApplyFeatures={applyFeatures}
          onApplyScope={applyScope}
          onApplyEntities={applyEntities}
          onApplyEndpoints={applyEndpoints}
          onApplyNfrs={applyNfrs}
          onApplyMetrics={applyMetrics}
          onApplyNotes={applyNotes}
        />
      ) : (
        <aside
          style={{
            padding: 16,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-subtle)",
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
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>
              Must-haves
            </h3>
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: passCount === rules.length ? "var(--success)" : "var(--text-tertiary)",
              }}
            >
              {passCount} / {rules.length}
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {rules.map((rule) => (
              <div key={rule.id} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <span
                  style={{
                    fontSize: 12,
                    marginTop: 1,
                    color: rule.pass ? "var(--success)" : "var(--text-muted)",
                  }}
                >
                  {rule.pass ? "✅" : "○"}
                </span>
                <div>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: rule.pass ? "var(--text-primary)" : "var(--text-secondary)",
                    }}
                  >
                    {rule.label}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                    {rule.description}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {isProductSpecComplete(canvas) && (
            <div
              style={{
                marginTop: 14,
                padding: 10,
                background: "var(--success-soft)",
                border: "1px solid var(--success-soft)",
                borderRadius: 6,
                fontSize: 12,
                color: "var(--success)",
                fontWeight: 600,
              }}
            >
              ✓ All must-haves complete — ready to advance to Wireframe stage.
            </div>
          )}
        </aside>
      )}
      {advanceModal !== null && (
        <AdvanceConfirmModal
          blockers={advanceModal.blockers}
          warnings={advanceModal.warnings}
          pendingReviewGate={advanceModal.pendingReviewGate}
          ventureRoot={venture.rootPath}
          currentStage={venture.stage}
          nextStage="SPEC_READY"
          onAdvance={commitAdvance}
          onClose={() => {
            setAdvanceModal(null);
            setAdvancing(false);
          }}
        />
      )}
      {distillDraft !== null && (
        <DistillDiffModal
          current={{
            purpose: canvas.purpose,
            inScope: canvas.inScope,
            outOfScope: canvas.outOfScope,
            notes: canvas.notes,
          }}
          proposed={distillDraft as Record<string, unknown>}
          fields={SPEC_DISTILL_FIELDS}
          onApply={handleApplyDistill}
          onClose={() => setDistillDraft(null)}
        />
      )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Sub-components — Section, Field, AddRowButton, Card variants
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
        background: "var(--bg-panel)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>
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
      <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 600 }}>{label}</span>
      {children}
    </label>
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
        background: "var(--bg-panel)",
        color: "var(--accent)",
        border: "1px dashed var(--accent-soft)",
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
        background: "var(--bg-panel)",
        color: "var(--danger)",
        border: "1px solid var(--danger-soft)",
        borderRadius: 4,
        cursor: "pointer",
        fontWeight: 600,
      }}
    >
      Remove
    </button>
  );
}

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: 12,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-subtle)",
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

// ── Persona ──────────────────────────────────────────────────────

function PersonaCard({
  persona,
  onChange,
  onRemove,
}: {
  persona: Persona;
  onChange: (patch: Partial<Persona>) => void;
  onRemove: () => void;
}) {
  return (
    <CardShell>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="text"
          value={persona.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Solo SaaS Founder"
          style={{ ...inputStyle, flex: 1, fontWeight: 600 }}
        />
        <RemoveButton onClick={onRemove} />
      </div>
      <Field label="Context">
        <textarea
          value={persona.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="Independent dev, 0-5 paid users, juggles product and support themselves."
          rows={2}
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </Field>
      <Field label="Primary goal (job-to-be-done)">
        <input
          type="text"
          value={persona.primaryGoal}
          onChange={(e) => onChange({ primaryGoal: e.target.value })}
          placeholder="Decide what to build next without flying blind."
          style={inputStyle}
        />
      </Field>
      <Field label="Pain points (one per line)">
        <textarea
          value={persona.painPoints.join("\n")}
          onChange={(e) =>
            onChange({
              painPoints: e.target.value
                .split("\n")
                .filter((s, i, arr) => i < arr.length - 1 || s.length > 0),
            })
          }
          placeholder={
            "Customer feedback scattered across email, Twitter, Discord\nNo signal on which feature requests are most common"
          }
          rows={3}
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </Field>
    </CardShell>
  );
}

// ── Feature ──────────────────────────────────────────────────────

function FeatureCard({
  feature,
  personas,
  onChange,
  onRemove,
}: {
  feature: Feature;
  personas: Persona[];
  onChange: (patch: Partial<Feature>) => void;
  onRemove: () => void;
}) {
  return (
    <CardShell>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="text"
          value={feature.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Sign up with email"
          style={{ ...inputStyle, flex: 1, fontWeight: 600 }}
        />
        <select
          value={feature.priority}
          onChange={(e) => onChange({ priority: e.target.value as FeaturePriority })}
          style={{ ...inputStyle, width: "auto" }}
        >
          {FeaturePrioritySchema.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt === "must" ? "Must" : opt === "should" ? "Should" : "Nice"}
            </option>
          ))}
        </select>
        <RemoveButton onClick={onRemove} />
      </div>
      <Field label="Description">
        <textarea
          value={feature.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="User can create an account using email + password and receive a verification link."
          rows={2}
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </Field>
      <Field label="Primary persona (optional)">
        <select
          value={feature.personaId}
          onChange={(e) => onChange({ personaId: e.target.value })}
          style={inputStyle}
        >
          <option value="">— All / unspecified —</option>
          {personas.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name || "(unnamed)"}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Acceptance criteria (one per line)">
        <textarea
          value={feature.acceptanceCriteria.join("\n")}
          onChange={(e) =>
            onChange({
              acceptanceCriteria: e.target.value
                .split("\n")
                .filter((s, i, arr) => i < arr.length - 1 || s.length > 0),
            })
          }
          placeholder={
            "User receives verification email within 30 seconds of submitting signup form\nUnverified accounts cannot access /dashboard"
          }
          rows={3}
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </Field>
    </CardShell>
  );
}

// ── Entity ───────────────────────────────────────────────────────

function EntityCard({
  entity,
  onChange,
  onRemove,
}: {
  entity: Entity;
  onChange: (patch: Partial<Entity>) => void;
  onRemove: () => void;
}) {
  const updateField = (idx: number, patch: Partial<EntityField>) => {
    onChange({
      fields: entity.fields.map((f, i) => (i === idx ? { ...f, ...patch } : f)),
    });
  };
  const addField = () => {
    onChange({
      fields: [...entity.fields, { name: "", type: "", required: false, description: "" }],
    });
  };
  const removeField = (idx: number) => {
    onChange({ fields: entity.fields.filter((_, i) => i !== idx) });
  };

  return (
    <CardShell>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="text"
          value={entity.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="User"
          style={{ ...inputStyle, flex: 1, fontWeight: 600 }}
        />
        <RemoveButton onClick={onRemove} />
      </div>
      <Field label="Description (optional)">
        <input
          type="text"
          value={entity.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="Authenticated end-user account"
          style={inputStyle}
        />
      </Field>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 600 }}>Fields</span>
        {entity.fields.map((f, idx) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static list, order does not change
            key={idx}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 60px auto",
              gap: 6,
              alignItems: "center",
            }}
          >
            <input
              type="text"
              value={f.name}
              onChange={(e) => updateField(idx, { name: e.target.value })}
              placeholder="email"
              style={{ ...inputStyle, fontSize: 12 }}
            />
            <input
              type="text"
              value={f.type}
              onChange={(e) => updateField(idx, { type: e.target.value })}
              placeholder="text / uuid / int / bool"
              style={{ ...inputStyle, fontSize: 12 }}
            />
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                color: "var(--text-secondary)",
              }}
            >
              <input
                type="checkbox"
                checked={f.required}
                onChange={(e) => updateField(idx, { required: e.target.checked })}
              />
              req
            </label>
            <button
              type="button"
              onClick={() => removeField(idx)}
              title="Remove field"
              style={{
                padding: "2px 6px",
                fontSize: 11,
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <AddRowButton label="+ Add field" onClick={addField} />
      </div>
    </CardShell>
  );
}

// ── API Endpoint ─────────────────────────────────────────────────

function EndpointCard({
  endpoint,
  onChange,
  onRemove,
}: {
  endpoint: ApiEndpoint;
  onChange: (patch: Partial<ApiEndpoint>) => void;
  onRemove: () => void;
}) {
  return (
    <CardShell>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <select
          value={endpoint.method}
          onChange={(e) => onChange({ method: e.target.value as HttpMethod })}
          style={{ ...inputStyle, width: 90 }}
        >
          {HttpMethodSchema.options.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={endpoint.path}
          onChange={(e) => onChange({ path: e.target.value })}
          placeholder="/api/projects"
          style={{
            ...inputStyle,
            flex: 1,
            fontFamily: "ui-monospace, monospace",
          }}
        />
        <RemoveButton onClick={onRemove} />
      </div>
      <Field label="Description">
        <input
          type="text"
          value={endpoint.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="List the current user's projects"
          style={inputStyle}
        />
      </Field>
      <Field label="Request notes (optional)">
        <textarea
          value={endpoint.requestNotes}
          onChange={(e) => onChange({ requestNotes: e.target.value })}
          placeholder="Query: ?status=active&limit=20"
          rows={2}
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </Field>
      <Field label="Response notes (optional)">
        <textarea
          value={endpoint.responseNotes}
          onChange={(e) => onChange({ responseNotes: e.target.value })}
          placeholder="200: { items: Project[], total: number }"
          rows={2}
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </Field>
    </CardShell>
  );
}

// ── NFR ──────────────────────────────────────────────────────────

function NfrCard({
  nfr,
  onChange,
  onRemove,
}: {
  nfr: NonFunctionalRequirement;
  onChange: (patch: Partial<NonFunctionalRequirement>) => void;
  onRemove: () => void;
}) {
  return (
    <CardShell>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <select
          value={nfr.category}
          onChange={(e) => onChange({ category: e.target.value as NonFunctionalCategory })}
          style={{ ...inputStyle, width: 150, textTransform: "capitalize" }}
        >
          {NonFunctionalCategorySchema.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={nfr.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="p95 response time under 200ms"
          style={{ ...inputStyle, flex: 1 }}
        />
        <RemoveButton onClick={onRemove} />
      </div>
      <Field label="Target">
        <input
          type="text"
          value={nfr.target}
          onChange={(e) => onChange({ target: e.target.value })}
          placeholder="200ms / WCAG 2.1 AA / 99.9%"
          style={inputStyle}
        />
      </Field>
    </CardShell>
  );
}

// ── Metric ───────────────────────────────────────────────────────

function MetricCard({
  metric,
  onChange,
  onRemove,
}: {
  metric: Metric;
  onChange: (patch: Partial<Metric>) => void;
  onRemove: () => void;
}) {
  return (
    <CardShell>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          type="text"
          value={metric.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Activation rate (first paid action within 7d)"
          style={{ ...inputStyle, flex: 1, fontWeight: 600 }}
        />
        <RemoveButton onClick={onRemove} />
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
        }}
      >
        <Field label="Target">
          <input
            type="text"
            value={metric.target}
            onChange={(e) => onChange({ target: e.target.value })}
            placeholder="40%"
            style={inputStyle}
          />
        </Field>
        <Field label="Current baseline (optional)">
          <input
            type="text"
            value={metric.currentBaseline}
            onChange={(e) => onChange({ currentBaseline: e.target.value })}
            placeholder="—"
            style={inputStyle}
          />
        </Field>
      </div>
    </CardShell>
  );
}

// ── SaveIndicator ────────────────────────────────────────────────

function SaveIndicator({
  status,
}: {
  status: "saved" | "saving" | "unsaved";
}) {
  const cfg = {
    saved: { color: "var(--success)", text: "Saved" },
    saving: { color: "var(--accent)", text: "Saving…" },
    unsaved: { color: "var(--warning)", text: "Unsaved" },
  }[status];
  return <span style={{ fontSize: 11, color: cfg.color, fontWeight: 600 }}>{cfg.text}</span>;
}

// ─────────────────────────────────────────────────────────────────
// Draft with AI — button + panel (pt.42a)
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
            : "Use the active LLM provider to draft a complete spec canvas"
      }
      style={{
        padding: "6px 14px",
        fontSize: 12,
        fontWeight: 600,
        background: isBusy ? "var(--accent-soft)" : "var(--accent)",
        color: isBusy ? "var(--accent)" : "var(--bg-panel)",
        border: "1px solid var(--accent)",
        borderRadius: 6,
        cursor: isBusy ? "default" : "pointer",
        opacity: isBusy ? 0.85 : 1,
      }}
    >
      {label}
    </button>
  );
}

type SpecDraftPanelProps = {
  phase: DraftPhase;
  draftCanvas: ProductSpecCanvas | null;
  error: string | null;
  providerDisplayName: string | null;
  model: string | null;
  /** Liveness-only — the panel just shows it ticking up so the founder
   *  knows the stream is alive. */
  deltaCount: number;
  sectionStates: Partial<Record<DraftSectionId, SectionState>>;
  onCancel: () => void;
  onRetry: () => void;
  onApplyAll: (mode: "replace" | "merge") => void;
  onApplyPurpose: (mode: "replace" | "skip") => void;
  onApplyPersonas: (mode: "replace" | "merge" | "skip") => void;
  onApplyFeatures: (mode: "replace" | "merge" | "skip") => void;
  onApplyScope: (mode: "replace" | "merge" | "skip") => void;
  onApplyEntities: (mode: "replace" | "merge" | "skip") => void;
  onApplyEndpoints: (mode: "replace" | "merge" | "skip") => void;
  onApplyNfrs: (mode: "replace" | "merge" | "skip") => void;
  onApplyMetrics: (mode: "replace" | "merge" | "skip") => void;
  onApplyNotes: (mode: "replace" | "skip") => void;
};

/**
 * Right-column panel for the AI draft flow. Replaces the must-haves
 * panel while a draft is open; the founder can Discard / Cancel to
 * close back to must-haves at any time.
 *
 * Layout:
 *   - Sticky header: title, provider · model line, Close button.
 *   - Body switches on phase:
 *       loading → spinner + tick counter + Cancel
 *       error   → message + Retry / Close
 *       success → Apply-all controls + per-section trio rows
 */
function SpecDraftPanel(props: SpecDraftPanelProps) {
  const {
    phase,
    draftCanvas,
    error,
    providerDisplayName,
    model,
    deltaCount,
    sectionStates,
    onCancel,
    onRetry,
    onApplyAll,
    onApplyPurpose,
    onApplyPersonas,
    onApplyFeatures,
    onApplyScope,
    onApplyEntities,
    onApplyEndpoints,
    onApplyNfrs,
    onApplyMetrics,
    onApplyNotes,
  } = props;

  return (
    <aside
      style={{
        padding: 0,
        background: "var(--bg-panel)",
        border: "1px solid var(--accent-soft)",
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
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--accent-soft)",
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
              color: "var(--accent-hover)",
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
              background: "var(--bg-panel)",
              color: "var(--accent)",
              border: "1px solid var(--accent-soft)",
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
            color: "var(--text-secondary)",
          }}
        >
          {providerDisplayName && model
            ? `Drafting with ${providerDisplayName} · ${model}`
            : "Drafting with the active provider"}
          {phase === "success" && (
            <span style={{ color: "var(--text-tertiary)" }}>
              {" "}
              — Replace overwrites the section, Merge appends.
            </span>
          )}
        </div>
      </div>

      {/* ── Body ───────────────────────────────────────────────── */}
      {phase === "loading" && (
        <div style={{ padding: 16, fontSize: 12, color: "var(--text-secondary)" }}>
          <div style={{ marginBottom: 8 }}>Drafting your spec from brand brief + research…</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {deltaCount > 0 ? `Streaming · ${deltaCount} chunks` : "Waiting for first token…"}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 12 }}>
            This usually takes 20–60 seconds depending on provider.
          </div>
        </div>
      )}

      {phase === "error" && (
        <div style={{ padding: 16, fontSize: 12, color: "var(--danger)" }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Couldn't complete the draft</div>
          <div
            style={{
              padding: 10,
              background: "var(--danger-soft)",
              border: "1px solid var(--danger-border)",
              borderRadius: 6,
              color: "var(--danger)",
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
                background: "var(--accent)",
                color: "var(--bg-panel)",
                border: "1px solid var(--accent)",
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
                background: "var(--bg-panel)",
                color: "var(--text-secondary)",
                border: "1px solid var(--border-input)",
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
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 6,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 600 }}>
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

          <DraftSectionRow
            id="purpose"
            label="1. Purpose"
            preview={draftCanvas.purpose || "(empty)"}
            count={draftCanvas.purpose.trim().length > 0 ? 1 : 0}
            singleton
            state={sectionStates.purpose ?? "pending"}
            onAction={(m) => onApplyPurpose(m === "merge" ? "replace" : (m as "replace" | "skip"))}
          />

          <DraftSectionRow
            id="personas"
            label="2. Personas"
            preview={
              draftCanvas.personas
                .filter((p) => p.name.trim().length > 0)
                .map((p) => p.name)
                .join(", ") || "(none)"
            }
            count={draftCanvas.personas.filter((p) => p.name.trim().length > 0).length}
            state={sectionStates.personas ?? "pending"}
            onAction={onApplyPersonas}
          />

          <DraftSectionRow
            id="features"
            label="3. Features"
            preview={
              draftCanvas.features
                .filter((f) => f.name.trim().length > 0)
                .slice(0, 3)
                .map((f) => `${f.priority === "must" ? "★" : "·"} ${f.name}`)
                .join("; ") || "(none)"
            }
            count={draftCanvas.features.filter((f) => f.name.trim().length > 0).length}
            state={sectionStates.features ?? "pending"}
            onAction={onApplyFeatures}
          />

          <DraftSectionRow
            id="scope"
            label="4. Scope"
            preview={`${draftCanvas.inScope.length} in / ${draftCanvas.outOfScope.length} out`}
            count={draftCanvas.inScope.length + draftCanvas.outOfScope.length}
            state={sectionStates.scope ?? "pending"}
            onAction={onApplyScope}
          />

          <DraftSectionRow
            id="entities"
            label="5. Data Model"
            preview={
              draftCanvas.dataModel.entities
                .filter((e) => e.name.trim().length > 0)
                .map((e) => e.name)
                .join(", ") || "(none)"
            }
            count={draftCanvas.dataModel.entities.filter((e) => e.name.trim().length > 0).length}
            state={sectionStates.entities ?? "pending"}
            onAction={onApplyEntities}
          />

          <DraftSectionRow
            id="endpoints"
            label="6. API Surface"
            preview={
              draftCanvas.apiSurface.endpoints
                .filter((e) => e.path.trim().length > 0)
                .slice(0, 3)
                .map((e) => `${e.method} ${e.path}`)
                .join(", ") || "(none)"
            }
            count={draftCanvas.apiSurface.endpoints.filter((e) => e.path.trim().length > 0).length}
            state={sectionStates.endpoints ?? "pending"}
            onAction={onApplyEndpoints}
          />

          <DraftSectionRow
            id="nfrs"
            label="7. NFRs"
            preview={
              draftCanvas.nonFunctional
                .filter((n) => n.description.trim().length > 0)
                .slice(0, 2)
                .map((n) => `${n.category}: ${n.description}`)
                .join("; ") || "(none)"
            }
            count={draftCanvas.nonFunctional.filter((n) => n.description.trim().length > 0).length}
            state={sectionStates.nfrs ?? "pending"}
            onAction={onApplyNfrs}
          />

          <DraftSectionRow
            id="metrics"
            label="8. Metrics"
            preview={
              draftCanvas.metrics
                .filter((m) => m.name.trim().length > 0)
                .slice(0, 3)
                .map((m) => `${m.name}: ${m.target || "—"}`)
                .join(", ") || "(none)"
            }
            count={draftCanvas.metrics.filter((m) => m.name.trim().length > 0).length}
            state={sectionStates.metrics ?? "pending"}
            onAction={onApplyMetrics}
          />

          <DraftSectionRow
            id="notes"
            label="Notes"
            preview={draftCanvas.notes || "(empty)"}
            count={draftCanvas.notes.trim().length > 0 ? 1 : 0}
            singleton
            state={sectionStates.notes ?? "pending"}
            onAction={(m) => onApplyNotes(m === "merge" ? "replace" : (m as "replace" | "skip"))}
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
    background: mode === "replace" ? "var(--accent)" : "var(--bg-panel)",
    color: mode === "replace" ? "var(--bg-panel)" : "var(--accent)",
    border: "1px solid var(--accent)",
    borderRadius: 4,
    cursor: "pointer",
  };
}

/**
 * Per-section row inside the draft panel. Shows a compact preview of
 * the AI's content + count chip + Replace / Merge / Skip controls (or
 * Replace / Skip when `singleton`). Collapses to a state stamp once
 * the founder commits one of the actions.
 *
 * `onAction` takes the trio mode; for singletons the parent maps
 * "merge" → "replace" before forwarding to the apply helper.
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
        background: isCommitted ? "var(--bg-elevated)" : "var(--bg-panel)",
        border: "1px solid var(--border-subtle)",
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
            color: "var(--text-primary)",
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
              background: count > 0 ? "var(--accent-soft)" : "var(--bg-hover)",
              color: count > 0 ? "var(--accent-hover)" : "var(--text-muted)",
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
                  ? "var(--text-tertiary)"
                  : state === "applied-merge"
                    ? "var(--success)"
                    : "var(--success)",
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
          color: "var(--text-tertiary)",
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
          <button type="button" onClick={() => onAction("replace")} style={trioBtn("primary")}>
            Replace
          </button>
          {!singleton && (
            <button type="button" onClick={() => onAction("merge")} style={trioBtn("secondary")}>
              Merge
            </button>
          )}
          <button type="button" onClick={() => onAction("skip")} style={trioBtn("muted")}>
            Skip
          </button>
        </div>
      )}
    </div>
  );
}

function trioBtn(variant: "primary" | "secondary" | "muted"): React.CSSProperties {
  if (variant === "primary") {
    return {
      flex: 1,
      padding: "5px 8px",
      fontSize: 11,
      fontWeight: 600,
      background: "var(--accent)",
      color: "var(--bg-panel)",
      border: "1px solid var(--accent)",
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
      background: "var(--bg-panel)",
      color: "var(--accent)",
      border: "1px solid var(--accent-soft)",
      borderRadius: 4,
      cursor: "pointer",
    };
  }
  return {
    flex: 1,
    padding: "5px 8px",
    fontSize: 11,
    fontWeight: 600,
    background: "var(--bg-panel)",
    color: "var(--text-tertiary)",
    border: "1px solid var(--border-subtle)",
    borderRadius: 4,
    cursor: "pointer",
  };
}

// ─────────────────────────────────────────────────────────────────
// Shared input style
// ─────────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  fontSize: 13,
  padding: "7px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-input)",
  background: "var(--bg-panel)",
  fontFamily: "inherit",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};
