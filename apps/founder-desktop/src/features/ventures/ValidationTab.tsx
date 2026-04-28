import type { Venture, VentureManifest, VentureStage } from "@founder-os/domain";
import { optimize } from "@founder-os/prompt-master";
import { invoke } from "@tauri-apps/api/core";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { pickActiveProvider, streamChat } from "../../lib/llm-client.js";
import { pushToast } from "../../lib/toasts.js";
import { joinPath } from "../../lib/venture-io.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExperimentStatus = "planned" | "running" | "done";
export type ExperimentType =
  | "customer_interview"
  | "landing_page"
  | "cold_outreach"
  | "smoke_test"
  | "prototype"
  | "survey"
  | "ad_campaign"
  | "other";

export type Experiment = {
  id: string;
  type: ExperimentType;
  description: string;
  hypothesis: string;
  result: string;
  status: ExperimentStatus;
};

export type ValidationDecision = "validated" | "pivot" | "invalidated" | "undecided";

export type ValidationCanvas = {
  // ICP
  icpDescription: string;
  icpRole: string;
  icpPain: string;
  icpCurrentSolution: string;
  icpTrigger: string;

  // Offer
  valueProposition: string;
  whatsIncluded: string;
  whatsExcluded: string;

  // Pricing
  pricePoint: string;
  pricingModel: string;
  priceSensitivityNotes: string;

  // Experiments
  experiments: Experiment[];

  // Results
  keyLearnings: string;
  whatChanged: string;
  validationDecision: ValidationDecision;
  decisionReason: string;

  updatedAt: string;
};

const DEFAULT_CANVAS: ValidationCanvas = {
  icpDescription: "",
  icpRole: "",
  icpPain: "",
  icpCurrentSolution: "",
  icpTrigger: "",
  valueProposition: "",
  whatsIncluded: "",
  whatsExcluded: "",
  pricePoint: "",
  pricingModel: "",
  priceSensitivityNotes: "",
  experiments: [],
  keyLearnings: "",
  whatChanged: "",
  validationDecision: "undecided",
  decisionReason: "",
  updatedAt: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Must-haves gate logic
// ---------------------------------------------------------------------------

type CheckKey =
  | "icpDefined"
  | "offerDefined"
  | "pricingDecided"
  | "experimentRun"
  | "resultsDocumented"
  | "decisionMade";

type ChecksMap = Record<CheckKey, boolean>;

function computeChecks(canvas: ValidationCanvas): ChecksMap {
  const doneExperiments = canvas.experiments.filter(
    (e) => e.status === "done" && e.description.trim().length > 0
  );
  return {
    icpDefined: canvas.icpDescription.trim().length >= 30 && canvas.icpPain.trim().length >= 20,
    offerDefined:
      canvas.valueProposition.trim().length >= 20 && canvas.whatsIncluded.trim().length >= 10,
    pricingDecided: canvas.pricePoint.trim().length >= 2,
    experimentRun: doneExperiments.length >= 1,
    resultsDocumented: canvas.keyLearnings.trim().length >= 30,
    decisionMade: canvas.validationDecision !== "undecided",
  };
}

const CHECK_LABELS: Record<CheckKey, string> = {
  icpDefined: "ICP fully defined",
  offerDefined: "Offer defined",
  pricingDecided: "Pricing decided",
  experimentRun: "1+ experiment completed",
  resultsDocumented: "Results documented",
  decisionMade: "Validation decision made",
};

const CHECK_HINTS: Record<CheckKey, string> = {
  icpDefined: "ICP description 30+ chars + pain 20+ chars",
  offerDefined: "Value prop 20+ chars + what's included",
  pricingDecided: "Enter a price point",
  experimentRun: "Mark at least one experiment as Done",
  resultsDocumented: "Key learnings 30+ chars",
  decisionMade: "Choose Validated, Pivot, or Invalidated",
};

const EXPERIMENT_TYPES: { value: ExperimentType; label: string }[] = [
  { value: "customer_interview", label: "Customer interview" },
  { value: "landing_page", label: "Landing page" },
  { value: "cold_outreach", label: "Cold outreach" },
  { value: "smoke_test", label: "Smoke test / fake door" },
  { value: "prototype", label: "Prototype / demo" },
  { value: "survey", label: "Survey" },
  { value: "ad_campaign", label: "Ad campaign" },
  { value: "other", label: "Other" },
];

const DECISION_CONFIG: Record<
  ValidationDecision,
  { color: string; label: string; sublabel: string }
> = {
  validated: {
    color: "#059669",
    label: "✅ Validated",
    sublabel: "Customers confirmed they'd pay",
  },
  pivot: { color: "#D97706", label: "🔄 Pivot", sublabel: "Core idea needs adjustment" },
  invalidated: { color: "#DC2626", label: "🛑 Invalidated", sublabel: "Not worth building as-is" },
  undecided: { color: "#9CA3AF", label: "⏳ Undecided", sublabel: "Still running experiments" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errDetail(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function makeid(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function canvasPath(rootPath: string): string {
  return joinPath(joinPath(rootPath, "02_validation"), "validation-canvas.json");
}

function uploadsDir(rootPath: string): string {
  return joinPath(joinPath(rootPath, "02_validation"), "experiments");
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function ValidationTab({
  venture,
  manifest,
  onAdvanceStage,
  onManifestUpdate,
}: {
  venture: Venture;
  manifest: VentureManifest | null;
  onAdvanceStage: (stage: VentureStage) => void;
  onManifestUpdate: (m: VentureManifest) => void;
}) {
  const [canvas, setCanvas] = useState<ValidationCanvas>(DEFAULT_CANVAS);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "unsaved">("saved");
  const [advancing, setAdvancing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [aiFillingDocs, setAiFillingDocs] = useState(false);
  const [uploadedDocs, setUploadedDocs] = useState<
    { id: string; name: string; savedPath: string; sizeKb: number }[]
  >([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Load canvas from disk
  useEffect(() => {
    let cancelled = false;
    invoke<string>("read_file", { path: canvasPath(venture.rootPath) })
      .then((raw) => {
        if (cancelled) return;
        try {
          setCanvas({ ...DEFAULT_CANVAS, ...JSON.parse(raw) });
        } catch {
          /* fresh */
        }
      })
      .catch(() => {
        if (!cancelled) setCanvas(DEFAULT_CANVAS);
      });
    return () => {
      cancelled = true;
    };
  }, [venture.id, venture.rootPath]);

  // Debounced save
  const scheduleSave = useCallback(
    (next: ValidationCanvas) => {
      setSaveStatus("unsaved");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        setSaveStatus("saving");
        try {
          await invoke("write_file", {
            path: canvasPath(venture.rootPath),
            content:
              JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 2) + "\n",
          });
        } catch (err) {
          pushToast({
            kind: "warn",
            message: "Couldn't save validation canvas",
            detail: errDetail(err),
          });
        }
        setSaveStatus("saved");
      }, 800);
    },
    [venture.rootPath]
  );

  const update = useCallback(
    (patch: Partial<ValidationCanvas>) => {
      setCanvas((prev) => {
        const next = { ...prev, ...patch };
        scheduleSave(next);
        return next;
      });
    },
    [scheduleSave]
  );

  // Load uploaded docs
  useEffect(() => {
    let cancelled = false;
    const dir = uploadsDir(venture.rootPath);
    invoke<string[]>("list_dir", { path: dir })
      .then((paths) => {
        if (cancelled) return;
        const docs = paths
          .map((p) => {
            const parts = p.replace(/\\/g, "/").split("/");
            const name = parts[parts.length - 1] ?? p;
            return { id: p, name, savedPath: p, sizeKb: 0 };
          })
          .filter((d) => !d.name.startsWith("."));
        setUploadedDocs(docs);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [venture.id, venture.rootPath]);

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    const dir = uploadsDir(venture.rootPath);
    try {
      await invoke("mkdir_p", { path: dir });
    } catch {
      /* ignore */
    }
    for (const file of Array.from(files)) {
      try {
        const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
        let content: string;
        if (["txt", "md", "csv", "json", "yaml", "yml", "xml"].includes(ext)) {
          content = await file.text();
        } else if (ext === "pdf") {
          const buf = await file.arrayBuffer();
          const b64 = arrayBufferToBase64(buf);
          try {
            const extracted = await invoke<string>("pdf_extract_text", { base64Bytes: b64 });
            if (!extracted.trim()) {
              pushToast({
                kind: "warn",
                message: `"${file.name}" — scanned PDF, no text extracted`,
                ttlMs: 6000,
              });
              continue;
            }
            const saveName = file.name.replace(/\.pdf$/i, ".extracted.txt");
            content = `[Extracted from PDF: ${file.name}]\n\n${extracted}`;
            await invoke("write_file", { path: joinPath(dir, saveName), content: content + "\n" });
            setUploadedDocs((prev) => [
              ...prev.filter((d) => d.id !== saveName),
              {
                id: saveName,
                name: saveName,
                savedPath: joinPath(dir, saveName),
                sizeKb: Math.round(content.length / 1024),
              },
            ]);
            pushToast({ kind: "success", message: `Saved "${saveName}"`, ttlMs: 3000 });
            continue;
          } catch {
            pushToast({ kind: "warn", message: `Couldn't extract text from "${file.name}"` });
            continue;
          }
        } else {
          pushToast({
            kind: "warn",
            message: `"${file.name}" — unsupported type`,
            detail: "Upload .txt .md .csv .json or .pdf",
            ttlMs: 5000,
          });
          continue;
        }
        await invoke("write_file", { path: joinPath(dir, file.name), content: content + "\n" });
        setUploadedDocs((prev) => [
          ...prev.filter((d) => d.id !== file.name),
          {
            id: file.name,
            name: file.name,
            savedPath: joinPath(dir, file.name),
            sizeKb: Math.round(content.length / 1024),
          },
        ]);
        pushToast({ kind: "success", message: `Saved "${file.name}"`, ttlMs: 3000 });
      } catch (err) {
        pushToast({
          kind: "error",
          message: `Couldn't save "${file.name}"`,
          detail: errDetail(err),
        });
      }
    }
    setUploading(false);
  };

  const handleAiFill = async () => {
    if (aiFillingDocs || uploadedDocs.length === 0) return;
    setAiFillingDocs(true);
    try {
      const providerId = await pickActiveProvider(venture.id);
      if (!providerId) {
        pushToast({
          kind: "warn",
          message: "No AI provider configured",
          detail: "Open Options tab to add an API key.",
        });
        return;
      }
      const docTexts: string[] = [];
      for (const doc of uploadedDocs) {
        try {
          const text = await invoke<string>("read_file", { path: doc.savedPath });
          docTexts.push(`[${doc.name}]\n${text}`);
        } catch {
          /* skip */
        }
      }
      if (docTexts.length === 0) {
        pushToast({ kind: "warn", message: "Couldn't read any uploaded documents" });
        return;
      }
      const combined = docTexts.join("\n\n---\n\n").slice(0, 15000);
      const system = `You extract validation and customer information from documents to pre-fill a validation canvas.
Only extract information clearly stated. Never invent facts. Return raw JSON only — no markdown, no explanation.
Omit any field where the document has no relevant info.`;
      const fields = {
        icpRole: "Job title or role of the ideal customer",
        icpDescription:
          "Full description of the ideal customer persona (demographics, situation, context)",
        icpPain: "Their #1 pain point — ideally in their own words",
        icpCurrentSolution: "What they currently use or do to solve the problem",
        icpTrigger: "What event triggers them to look for a new solution",
        valueProposition: "One-sentence value proposition or core offer",
        whatsIncluded: "Features or capabilities included in the first version",
        pricePoint: "Proposed price point (number + currency + frequency)",
        pricingModel: "How the pricing is structured (subscription, one-off, usage-based, etc.)",
        keyLearnings: "Key learnings from customer interviews or validation experiments",
      };
      const optimizedSystem = await optimize({
        prompt: system,
        context: "research",
        ventureId: venture.id,
      });
      console.info(
        "[prompt-master] validation-extract",
        optimizedSystem.fallbackUsed
          ? "(fallback — transport unavailable)"
          : `tokensSaved=${optimizedSystem.tokensSaved} cacheHit=${optimizedSystem.cacheHit}`
      );
      let responseText = "";
      await streamChat({
        provider: providerId,
        messages: [
          {
            role: "user",
            content: `Documents:\n\n${combined}\n\n---\nExtract these fields if present:\n${JSON.stringify(fields, null, 2)}\n\nReturn JSON only.`,
          },
        ],
        system: optimizedSystem.optimized,
        maxTokens: 1200,
        temperature: 0.1,
        onDelta: (d) => {
          responseText += d;
        },
      });
      const jsonMatch =
        responseText.match(/```(?:json)?\s*([\s\S]*?)```/) || responseText.match(/(\{[\s\S]*\})/);
      const result = JSON.parse((jsonMatch ? jsonMatch[1] : responseText).trim()) as Record<
        string,
        string
      >;
      const patch: Partial<ValidationCanvas> = {};
      let filled = 0;
      if (result.icpRole) {
        patch.icpRole = result.icpRole;
        filled++;
      }
      if (result.icpDescription) {
        patch.icpDescription = result.icpDescription;
        filled++;
      }
      if (result.icpPain) {
        patch.icpPain = result.icpPain;
        filled++;
      }
      if (result.icpCurrentSolution) {
        patch.icpCurrentSolution = result.icpCurrentSolution;
        filled++;
      }
      if (result.icpTrigger) {
        patch.icpTrigger = result.icpTrigger;
        filled++;
      }
      if (result.valueProposition) {
        patch.valueProposition = result.valueProposition;
        filled++;
      }
      if (result.whatsIncluded) {
        patch.whatsIncluded = result.whatsIncluded;
        filled++;
      }
      if (result.pricePoint) {
        patch.pricePoint = result.pricePoint;
        filled++;
      }
      if (result.pricingModel) {
        patch.pricingModel = result.pricingModel;
        filled++;
      }
      if (result.keyLearnings) {
        patch.keyLearnings = result.keyLearnings;
        filled++;
      }
      if (filled > 0) {
        update(patch);
        pushToast({
          kind: "success",
          message: `✨ AI filled ${filled} field${filled > 1 ? "s" : ""} from your documents`,
          ttlMs: 5000,
        });
      } else {
        pushToast({
          kind: "warn",
          message: "AI couldn't find matching fields in your documents",
          ttlMs: 5000,
        });
      }
    } catch (err) {
      pushToast({ kind: "error", message: "AI fill failed", detail: errDetail(err) });
    } finally {
      setAiFillingDocs(false);
    }
  };

  // Experiment helpers
  const addExperiment = () => {
    update({
      experiments: [
        ...canvas.experiments,
        {
          id: makeid(),
          type: "customer_interview",
          description: "",
          hypothesis: "",
          result: "",
          status: "planned",
        },
      ],
    });
  };

  const updateExp = (id: string, patch: Partial<Experiment>) => {
    update({ experiments: canvas.experiments.map((e) => (e.id === id ? { ...e, ...patch } : e)) });
  };

  const removeExp = (id: string) => {
    update({ experiments: canvas.experiments.filter((e) => e.id !== id) });
  };

  const checks = computeChecks(canvas);
  const doneCount = Object.values(checks).filter(Boolean).length;
  const allDone = doneCount === 6;

  const handleAdvance = async () => {
    if (!allDone || advancing) return;
    setAdvancing(true);
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    try {
      await invoke("write_file", {
        path: canvasPath(venture.rootPath),
        content: JSON.stringify({ ...canvas, updatedAt: new Date().toISOString() }, null, 2) + "\n",
      });
    } catch (err) {
      pushToast({
        kind: "warn",
        message: "Couldn't save before advancing",
        detail: errDetail(err),
      });
    }
    onAdvanceStage("BRAND_READY");
    setAdvancing(false);
  };

  return (
    <div
      style={{ height: "100%", overflow: "auto", padding: "24px 28px", boxSizing: "border-box" }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          marginBottom: 24,
          gap: 20,
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#111827" }}>
            Validation Canvas
          </h3>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6B7280" }}>
            Test your riskiest assumptions before spending a penny on code. Saves automatically.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <SaveIndicator status={saveStatus} />
          <button
            type="button"
            onClick={handleAdvance}
            disabled={!allDone || advancing}
            title={
              allDone
                ? "All must-haves complete — advance to Brand stage"
                : "Complete the checklist first"
            }
            style={{
              padding: "8px 16px",
              background: allDone ? "#6366F1" : "#E5E7EB",
              color: allDone ? "#FFFFFF" : "#9CA3AF",
              border: "none",
              borderRadius: 6,
              fontWeight: 700,
              fontSize: 13,
              cursor: allDone ? "pointer" : "not-allowed",
              transition: "background 0.2s",
              whiteSpace: "nowrap",
            }}
          >
            {advancing ? "Advancing…" : "Advance to Brand →"}
          </button>
        </div>
      </div>

      {/* Two-column layout */}
      <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
        {/* LEFT */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Section 1 — Supporting Documents */}
          <Section title="1. Supporting Documents" icon="📎">
            <p style={{ margin: "0 0 8px", fontSize: 12, color: "#6B7280" }}>
              Upload customer interview notes, survey results, landing page analytics, or any
              validation evidence. AI will read them and auto-fill matching fields below. Saved to{" "}
              <code>02_validation/experiments/</code>. Supports .txt, .md, .csv, .json and .pdf.
            </p>
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                handleFileUpload(e.dataTransfer.files);
              }}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: "2px dashed #D1D5DB",
                borderRadius: 8,
                padding: "20px 16px",
                textAlign: "center",
                cursor: "pointer",
                background: uploading ? "#F0FDF4" : "#F9FAFB",
                color: "#6B7280",
                fontSize: 13,
                transition: "border-color 0.15s",
              }}
            >
              <div style={{ fontSize: 22, marginBottom: 6 }}>📂</div>
              {uploading ? "Saving…" : "Click or drag files here to upload"}
              <div style={{ fontSize: 11, marginTop: 4, color: "#9CA3AF" }}>
                .txt · .md · .csv · .json · .pdf
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".txt,.md,.csv,.json,.yaml,.yml,.xml,.pdf"
                style={{ display: "none" }}
                onChange={(e) => handleFileUpload(e.target.files)}
              />
            </div>
            {uploadedDocs.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <button
                  type="button"
                  onClick={handleAiFill}
                  disabled={aiFillingDocs}
                  style={{
                    alignSelf: "flex-start",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "8px 14px",
                    background: aiFillingDocs ? "#F9FAFB" : "#EEF2FF",
                    border: `1px solid ${aiFillingDocs ? "#E5E7EB" : "#C7D2FE"}`,
                    borderRadius: 6,
                    fontSize: 13,
                    color: aiFillingDocs ? "#9CA3AF" : "#4F46E5",
                    cursor: aiFillingDocs ? "not-allowed" : "pointer",
                    fontWeight: 600,
                  }}
                >
                  <span>{aiFillingDocs ? "⏳" : "🤖"}</span>
                  {aiFillingDocs ? "AI reading documents…" : "AI fill from documents"}
                </button>
                {uploadedDocs.map((doc) => (
                  <div
                    key={doc.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 12px",
                      background: "#FFFFFF",
                      border: "1px solid #E5E7EB",
                      borderRadius: 6,
                      fontSize: 13,
                    }}
                  >
                    <span style={{ fontSize: 16 }}>📄</span>
                    <span
                      style={{
                        flex: 1,
                        color: "#111827",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {doc.name}
                    </span>
                    {doc.sizeKb > 0 && (
                      <span style={{ fontSize: 11, color: "#9CA3AF" }}>{doc.sizeKb} KB</span>
                    )}
                    <button
                      type="button"
                      onClick={() => invoke("open_path", { path: doc.savedPath }).catch(() => {})}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        fontSize: 14,
                        padding: "2px 4px",
                        borderRadius: 4,
                        color: "#6366F1",
                      }}
                      title="Open in file manager"
                    >
                      ↗
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Section 2 — ICP */}
          <Section title="2. Ideal Customer Profile (ICP)" icon="🎯">
            <p style={{ margin: "0 0 4px", fontSize: 12, color: "#6B7280" }}>
              Get ultra-specific. The narrower your ICP now, the easier everything downstream
              becomes.
            </p>

            <div style={{ display: "flex", gap: 12 }}>
              <Field label="Job title / role" style={{ flex: 1 }}>
                <input
                  type="text"
                  value={canvas.icpRole}
                  onChange={(e) => update({ icpRole: e.target.value })}
                  placeholder="e.g. Freelance developer, UK, solo, 3–10 active clients"
                  style={inputStyle}
                />
              </Field>
            </div>

            <Field
              label="Full ICP description"
              required
              hint="Demographics, firmographics, situation — paint a picture of one specific person."
            >
              <Textarea
                value={canvas.icpDescription}
                onChange={(v) => update({ icpDescription: v })}
                placeholder="e.g. James, 32, freelance React developer based in Manchester. Works from home. Bills 6–8 clients a month on 30-day net terms. Earns £70–90k/yr. Uses FreeAgent but finds it overkill. Chases invoices via WhatsApp and feels awkward doing it."
                rows={4}
              />
              <CharCount value={canvas.icpDescription} min={30} />
            </Field>

            <Field
              label="Their #1 pain point (in their words)"
              required
              hint="What frustrates them most about the current way they solve this problem?"
            >
              <Textarea
                value={canvas.icpPain}
                onChange={(v) => update({ icpPain: v })}
                placeholder="e.g. 'I lose hours every week chasing late payers. I hate the awkward emails and I'm scared to push too hard in case I lose the client.'"
                rows={3}
              />
              <CharCount value={canvas.icpPain} min={20} />
            </Field>

            <Field
              label="What they currently use to solve it"
              hint="Manual process, spreadsheet, competitor tool, or nothing?"
            >
              <input
                type="text"
                value={canvas.icpCurrentSolution}
                onChange={(e) => update({ icpCurrentSolution: e.target.value })}
                placeholder="e.g. Manual WhatsApp messages + occasional awkward email via FreeAgent"
                style={inputStyle}
              />
            </Field>

            <Field
              label="What triggers them to look for a new solution?"
              hint="What event or threshold makes them finally act?"
            >
              <input
                type="text"
                value={canvas.icpTrigger}
                onChange={(e) => update({ icpTrigger: e.target.value })}
                placeholder="e.g. A client ghosts them on a £3,000 invoice and they lose the money"
                style={inputStyle}
              />
            </Field>
          </Section>

          {/* Section 3 — Offer */}
          <Section title="3. Your Offer" icon="📦">
            <Field
              label="One-sentence value proposition"
              required
              hint="Complete the sentence: 'We help [ICP] to [outcome] without [pain/obstacle].'"
            >
              <Textarea
                value={canvas.valueProposition}
                onChange={(v) => update({ valueProposition: v })}
                placeholder="e.g. InvoiceChaser helps UK freelancers get paid on time automatically — without awkward chasing emails — so they can focus on client work."
                rows={2}
              />
              <CharCount value={canvas.valueProposition} min={20} />
            </Field>

            <Field
              label="What's included in v1?"
              required
              hint="Features and capabilities in the first release. Be specific — this becomes your scope."
            >
              <Textarea
                value={canvas.whatsIncluded}
                onChange={(v) => update({ whatsIncluded: v })}
                placeholder={`e.g.\n- Automated invoice reminders (3-email sequence, configurable timing)\n- Overdue dashboard with client health score\n- FreeAgent + Xero import\n- Email + SMS nudges`}
                rows={4}
              />
              <CharCount value={canvas.whatsIncluded} min={10} />
            </Field>

            <Field
              label="What's NOT in v1?"
              hint="Explicitly cut features to avoid scope creep. Sets expectations with early users."
            >
              <Textarea
                value={canvas.whatsExcluded}
                onChange={(v) => update({ whatsExcluded: v })}
                placeholder={`e.g.\n- No full accounting module\n- No mobile app\n- No QuickBooks integration (v2)\n- No legal debt collection escalation`}
                rows={3}
              />
            </Field>
          </Section>

          {/* Section 4 — Pricing */}
          <Section title="4. Pricing" icon="💷">
            <div style={{ display: "flex", gap: 12 }}>
              <Field label="Price point" required hint="What will you charge?" style={{ flex: 1 }}>
                <input
                  type="text"
                  value={canvas.pricePoint}
                  onChange={(e) => update({ pricePoint: e.target.value })}
                  placeholder="e.g. £12/mo or £99 one-off"
                  style={inputStyle}
                />
              </Field>
              <Field label="Pricing model" hint="How is it structured?" style={{ flex: 1 }}>
                <input
                  type="text"
                  value={canvas.pricingModel}
                  onChange={(e) => update({ pricingModel: e.target.value })}
                  placeholder="e.g. Monthly subscription, cancel anytime"
                  style={inputStyle}
                />
              </Field>
            </div>
            <Field
              label="Price sensitivity notes"
              hint="How did prospects react when you told them the price? What's the ceiling?"
            >
              <Textarea
                value={canvas.priceSensitivityNotes}
                onChange={(v) => update({ priceSensitivityNotes: v })}
                placeholder="e.g. 8/12 interviewees said £10–15/mo felt reasonable. 3 said they'd pay up to £25. 1 said they wouldn't pay at all — uses free reminder apps. £9.99 sweet spot confirmed by willingness-to-pay survey (n=47)."
                rows={3}
              />
            </Field>
          </Section>

          {/* Section 5 — Experiments */}
          <Section title="5. Validation Experiments" icon="🧪">
            <p style={{ margin: "0 0 4px", fontSize: 12, color: "#6B7280" }}>
              Log each experiment you ran or plan to run. Mark at least one as Done to advance.
            </p>

            {canvas.experiments.length === 0 && (
              <div
                style={{
                  padding: "16px",
                  textAlign: "center",
                  background: "#F9FAFB",
                  borderRadius: 8,
                  border: "1px dashed #D1D5DB",
                  color: "#9CA3AF",
                  fontSize: 13,
                }}
              >
                No experiments yet. Add one below to get started.
              </div>
            )}

            {canvas.experiments.map((exp, idx) => (
              <ExperimentRow
                key={exp.id}
                index={idx + 1}
                experiment={exp}
                onChange={(patch) => updateExp(exp.id, patch)}
                onRemove={() => removeExp(exp.id)}
              />
            ))}

            <button
              type="button"
              onClick={addExperiment}
              style={{
                alignSelf: "flex-start",
                padding: "7px 14px",
                background: "#F3F4F6",
                border: "1px dashed #D1D5DB",
                borderRadius: 6,
                fontSize: 13,
                color: "#374151",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              + Add experiment
            </button>
          </Section>

          {/* Section 6 — Results & Decision */}
          <Section title="6. Results & Decision" icon="📋">
            <Field
              label="Key learnings"
              required
              hint="What did you learn from your experiments? Surprises, confirmations, doubts?"
            >
              <Textarea
                value={canvas.keyLearnings}
                onChange={(v) => update({ keyLearnings: v })}
                placeholder="e.g. 10/12 interviewees confirmed late payment is their #1 frustration. All 10 said they'd pay for a solution. Surprising: 6 didn't want SMS — found it unprofessional. Landing page: 34% email capture from 280 visitors, 9 said 'take my money'. Price point of £12/mo met no resistance."
                rows={5}
              />
              <CharCount value={canvas.keyLearnings} min={30} />
            </Field>

            <Field
              label="What changed from your original assumptions?"
              hint="Were you wrong about anything? Did the ICP shift? Did the solution change?"
            >
              <Textarea
                value={canvas.whatChanged}
                onChange={(v) => update({ whatChanged: v })}
                placeholder="e.g. Originally planned SMS nudges — dropped after feedback. Discovered accountants are actually a better ICP than solo freelancers for the higher price tier."
                rows={3}
              />
            </Field>

            <div>
              <p style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 600, color: "#374151" }}>
                Validation decision <span style={{ color: "#EF4444" }}>*</span>
              </p>
              <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                {(["validated", "pivot", "invalidated", "undecided"] as ValidationDecision[]).map(
                  (d) => {
                    const cfg = DECISION_CONFIG[d];
                    const active = canvas.validationDecision === d;
                    return (
                      <button
                        key={d}
                        type="button"
                        onClick={() => update({ validationDecision: d })}
                        style={{
                          flex: 1,
                          minWidth: 120,
                          padding: "10px 8px",
                          border: `2px solid ${active ? cfg.color : "#E5E7EB"}`,
                          borderRadius: 8,
                          background: active ? `${cfg.color}14` : "#FFFFFF",
                          color: active ? cfg.color : "#6B7280",
                          cursor: "pointer",
                          transition: "all 0.15s",
                          textAlign: "center",
                        }}
                      >
                        <div style={{ fontSize: 13, fontWeight: 700 }}>{cfg.label}</div>
                        <div style={{ fontSize: 10, marginTop: 2, opacity: 0.8 }}>
                          {cfg.sublabel}
                        </div>
                      </button>
                    );
                  }
                )}
              </div>

              {canvas.validationDecision !== "undecided" && (
                <Textarea
                  value={canvas.decisionReason}
                  onChange={(v) => update({ decisionReason: v })}
                  placeholder={
                    canvas.validationDecision === "validated"
                      ? "What evidence confirms this is worth building? e.g. 9 verbal commitments, 34% landing page conversion, £12/mo price point confirmed."
                      : canvas.validationDecision === "pivot"
                        ? "What needs to change? e.g. Shifting ICP from solo freelancers to small agencies — higher willingness to pay and more invoices to chase."
                        : "Why not? What would need to be true for this to work? e.g. Market too small, competitors too entrenched, no willingness to pay above £5/mo."
                  }
                  rows={3}
                />
              )}
            </div>
          </Section>
        </div>

        {/* RIGHT — sticky checklist */}
        <div style={{ width: 240, flexShrink: 0, position: "sticky", top: 0 }}>
          <div
            style={{
              background: "#FFFFFF",
              border: "1px solid #E5E7EB",
              borderRadius: 10,
              padding: 16,
              boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: "#374151",
                marginBottom: 12,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
              }}
            >
              Must-haves
            </div>

            <div
              style={{
                height: 6,
                background: "#E5E7EB",
                borderRadius: 3,
                marginBottom: 14,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${(doneCount / 6) * 100}%`,
                  background: allDone ? "#059669" : "#6366F1",
                  borderRadius: 3,
                  transition: "width 0.3s ease",
                }}
              />
            </div>
            <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 14, textAlign: "right" }}>
              {doneCount} / 6 complete
            </div>

            {(Object.keys(checks) as CheckKey[]).map((key) => (
              <ChecklistItem
                key={key}
                done={checks[key]}
                label={CHECK_LABELS[key]}
                hint={CHECK_HINTS[key]}
              />
            ))}

            <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid #E5E7EB" }}>
              <button
                type="button"
                onClick={handleAdvance}
                disabled={!allDone || advancing}
                style={{
                  width: "100%",
                  padding: "9px 12px",
                  background: allDone ? "#6366F1" : "#E5E7EB",
                  color: allDone ? "#FFFFFF" : "#9CA3AF",
                  border: "none",
                  borderRadius: 6,
                  fontWeight: 700,
                  fontSize: 12,
                  cursor: allDone ? "pointer" : "not-allowed",
                  transition: "background 0.2s",
                }}
              >
                {advancing
                  ? "Advancing…"
                  : allDone
                    ? "Advance to Brand →"
                    : "Complete checklist first"}
              </button>
              {allDone && (
                <p
                  style={{ margin: "8px 0 0", fontSize: 11, color: "#059669", textAlign: "center" }}
                >
                  Validated! Moves you to BRAND_READY.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExperimentRow
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<ExperimentStatus, string> = {
  planned: "#6B7280",
  running: "#D97706",
  done: "#059669",
};

function ExperimentRow({
  index,
  experiment,
  onChange,
  onRemove,
}: {
  index: number;
  experiment: Experiment;
  onChange: (patch: Partial<Experiment>) => void;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        border: `1px solid ${experiment.status === "done" ? "#D1FAE5" : "#E5E7EB"}`,
        borderRadius: 8,
        padding: "14px 14px",
        background: experiment.status === "done" ? "#F0FDF4" : "#F9FAFB",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {/* Row header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#9CA3AF", minWidth: 80 }}>
          Experiment {index}
        </span>

        <select
          value={experiment.type}
          onChange={(e) => onChange({ type: e.target.value as ExperimentType })}
          style={{ ...selectStyle, flex: 1 }}
        >
          {EXPERIMENT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>

        {/* Status pill */}
        <select
          value={experiment.status}
          onChange={(e) => onChange({ status: e.target.value as ExperimentStatus })}
          style={{
            fontSize: 11,
            padding: "4px 8px",
            borderRadius: 12,
            border: `1px solid ${STATUS_COLORS[experiment.status]}`,
            background: "#FFFFFF",
            color: STATUS_COLORS[experiment.status],
            fontWeight: 700,
            cursor: "pointer",
            outline: "none",
          }}
        >
          <option value="planned">Planned</option>
          <option value="running">Running</option>
          <option value="done">Done ✓</option>
        </select>

        <button
          type="button"
          onClick={onRemove}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "#9CA3AF",
            fontSize: 16,
            padding: "2px 4px",
            borderRadius: 4,
            lineHeight: 1,
          }}
          title="Remove"
        >
          ×
        </button>
      </div>

      <input
        type="text"
        value={experiment.description}
        onChange={(e) => onChange({ description: e.target.value })}
        placeholder="What did you do? e.g. Cold emailed 40 freelancers on LinkedIn asking about invoice pain"
        style={inputStyle}
      />

      <input
        type="text"
        value={experiment.hypothesis}
        onChange={(e) => onChange({ hypothesis: e.target.value })}
        placeholder="Hypothesis: e.g. 50%+ will say late payment is their biggest admin headache"
        style={inputStyle}
      />

      {experiment.status === "done" && (
        <textarea
          value={experiment.result}
          onChange={(e) => onChange({ result: e.target.value })}
          placeholder="Result: e.g. 31/40 replied. 28 said late payment is top-3 pain. 9 asked to be notified when product launches."
          rows={2}
          style={{
            fontSize: 13,
            padding: "8px 10px",
            borderRadius: 6,
            border: "1px solid #A7F3D0",
            background: "#FFFFFF",
            resize: "vertical",
            fontFamily: "inherit",
            lineHeight: 1.5,
            outline: "none",
            width: "100%",
            boxSizing: "border-box",
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Section({
  title,
  icon,
  children,
}: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "#FFFFFF",
        border: "1px solid #E5E7EB",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "14px 18px",
          borderBottom: "1px solid #F3F4F6",
          background: "#F9FAFB",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 16 }}>{icon}</span>
        <h4 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#111827" }}>{title}</h4>
      </div>
      <div style={{ padding: "18px 18px", display: "flex", flexDirection: "column", gap: 16 }}>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  hint,
  style: styleProp,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5, ...styleProp }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>
        {label}
        {required && <span style={{ color: "#EF4444", marginLeft: 4 }}>*</span>}
      </span>
      {hint && <span style={{ fontSize: 11, color: "#9CA3AF", marginTop: -2 }}>{hint}</span>}
      {children}
    </label>
  );
}

function Textarea({
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      style={{
        fontSize: 13,
        padding: "9px 11px",
        borderRadius: 6,
        border: "1px solid #D1D5DB",
        background: "#FFFFFF",
        resize: "vertical",
        fontFamily: "inherit",
        lineHeight: 1.5,
        outline: "none",
        width: "100%",
        boxSizing: "border-box",
      }}
    />
  );
}

function CharCount({ value, min }: { value: string; min: number }) {
  const len = value.trim().length;
  const ok = len >= min;
  return (
    <span style={{ fontSize: 11, color: ok ? "#059669" : "#9CA3AF", marginTop: -2 }}>
      {len} / {min} chars {ok ? "✓" : ""}
    </span>
  );
}

function ChecklistItem({ done, label, hint }: { done: boolean; label: string; hint: string }) {
  return (
    <div
      title={done ? "Complete" : hint}
      style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 10 }}
    >
      <div
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: done ? "#059669" : "#E5E7EB",
          border: done ? "none" : "2px solid #D1D5DB",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginTop: 1,
          transition: "background 0.2s",
        }}
      >
        {done && (
          <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
            <path
              d="M1 4L3.5 6.5L9 1"
              stroke="white"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: done ? "#111827" : "#6B7280" }}>
          {label}
        </div>
        {!done && <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 1 }}>{hint}</div>}
      </div>
    </div>
  );
}

function SaveIndicator({ status }: { status: "saved" | "saving" | "unsaved" }) {
  const cfg = {
    saved: { color: "#059669", text: "Saved" },
    saving: { color: "#6366F1", text: "Saving…" },
    unsaved: { color: "#D97706", text: "Unsaved" },
  }[status];
  return <span style={{ fontSize: 11, color: cfg.color, fontWeight: 600 }}>{cfg.text}</span>;
}

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

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

const selectStyle: React.CSSProperties = { ...inputStyle };
