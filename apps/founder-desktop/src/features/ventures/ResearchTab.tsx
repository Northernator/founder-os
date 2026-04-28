import type { Venture, VentureManifest, VentureStage } from "@founder-os/domain";
import { optimize } from "@founder-os/prompt-master";
import { invoke } from "@tauri-apps/api/core";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { pickActiveProvider, streamChat } from "../../lib/llm-client.js";
import { pushToast } from "../../lib/toasts.js";
import { joinPath, writeVentureManifest } from "../../lib/venture-io.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Competitor = {
  id: string;
  name: string;
  weakness: string;
};

export type EvidenceType =
  | "customer_interviews"
  | "surveys"
  | "forum_posts"
  | "search_trends"
  | "waitlist_signups"
  | "social_media"
  | "industry_reports";

export type GoNoGo = "go" | "no_go" | "undecided";

export type ResearchCanvas = {
  // Market
  marketSummary: string;
  tamEstimate: string;
  samEstimate: string;
  keyMarketGap: string;

  // Competitors
  competitors: Competitor[];
  differentiator: string;

  // Customer Problems
  topProblems: string;
  customerQuotes: string;

  // Validation Evidence
  evidenceTypes: EvidenceType[];
  evidenceNotes: string;

  // Summary
  researchSummary: string;
  goNoGo: GoNoGo;
  goNoGoReason: string;

  updatedAt: string;
};

type UploadedDoc = {
  id: string;
  name: string;
  savedPath: string;
  sizeKb: number;
};

const DEFAULT_CANVAS: ResearchCanvas = {
  marketSummary: "",
  tamEstimate: "",
  samEstimate: "",
  keyMarketGap: "",
  competitors: [],
  differentiator: "",
  topProblems: "",
  customerQuotes: "",
  evidenceTypes: [],
  evidenceNotes: "",
  researchSummary: "",
  goNoGo: "undecided",
  goNoGoReason: "",
  updatedAt: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Must-haves gate logic
// ---------------------------------------------------------------------------

type CheckKey =
  | "marketSized"
  | "gapIdentified"
  | "competitorsAnalysed"
  | "differentiationClear"
  | "problemsDocumented"
  | "conclusionReached";

type ChecksMap = Record<CheckKey, boolean>;

function computeChecks(canvas: ResearchCanvas): ChecksMap {
  return {
    marketSized: canvas.marketSummary.trim().length >= 30 && canvas.tamEstimate.trim().length >= 5,
    gapIdentified: canvas.keyMarketGap.trim().length >= 20,
    competitorsAnalysed: canvas.competitors.filter((c) => c.name.trim().length > 0).length >= 2,
    differentiationClear: canvas.differentiator.trim().length >= 20,
    problemsDocumented: canvas.topProblems.trim().length >= 30,
    conclusionReached: canvas.goNoGo !== "undecided",
  };
}

const CHECK_LABELS: Record<CheckKey, string> = {
  marketSized: "Market sized",
  gapIdentified: "Market gap identified",
  competitorsAnalysed: "2+ competitors analysed",
  differentiationClear: "Differentiation clear",
  problemsDocumented: "Customer problems documented",
  conclusionReached: "Go / No-go decision made",
};

const CHECK_HINTS: Record<CheckKey, string> = {
  marketSized: "Describe the market + estimate TAM",
  gapIdentified: "What gap or unmet need did you find? 20+ chars",
  competitorsAnalysed: "Add at least 2 competitors below",
  differentiationClear: "Why is yours different? 20+ chars",
  problemsDocumented: "Describe the top customer problems 30+ chars",
  conclusionReached: "Decide Go or No-Go at the bottom",
};

const EVIDENCE_OPTIONS: { value: EvidenceType; label: string }[] = [
  { value: "customer_interviews", label: "Customer interviews" },
  { value: "surveys", label: "Online surveys" },
  { value: "forum_posts", label: "Forum / Reddit research" },
  { value: "search_trends", label: "Search trend data" },
  { value: "waitlist_signups", label: "Waitlist sign-ups" },
  { value: "social_media", label: "Social media signals" },
  { value: "industry_reports", label: "Industry reports" },
];

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
    : `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function canvasPath(rootPath: string): string {
  return joinPath(joinPath(rootPath, "01_research"), "research-canvas.json");
}

function uploadsDir(rootPath: string): string {
  return joinPath(joinPath(rootPath, "01_research"), "uploads");
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function ResearchTab({
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
  const [canvas, setCanvas] = useState<ResearchCanvas>(DEFAULT_CANVAS);
  const [uploadedDocs, setUploadedDocs] = useState<UploadedDoc[]>([]);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "unsaved">("saved");
  const [advancing, setAdvancing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [aiFillingDocs, setAiFillingDocs] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Load canvas from disk on venture change
  useEffect(() => {
    let cancelled = false;
    const path = canvasPath(venture.rootPath);
    invoke<string>("read_file", { path })
      .then((raw) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(raw) as ResearchCanvas;
          setCanvas({ ...DEFAULT_CANVAS, ...parsed });
        } catch {
          // malformed — start fresh
        }
      })
      .catch(() => {
        if (!cancelled) setCanvas(DEFAULT_CANVAS);
      });
    return () => {
      cancelled = true;
    };
  }, [venture.id, venture.rootPath]);

  // Load uploaded docs list from disk
  useEffect(() => {
    let cancelled = false;
    const dir = uploadsDir(venture.rootPath);
    invoke<string[]>("list_dir", { path: dir })
      .then((paths) => {
        if (cancelled) return;
        const docs: UploadedDoc[] = paths
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

  // Debounced save
  const scheduleSave = useCallback(
    (nextCanvas: ResearchCanvas) => {
      setSaveStatus("unsaved");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        setSaveStatus("saving");
        const toSave: ResearchCanvas = {
          ...nextCanvas,
          updatedAt: new Date().toISOString(),
        };
        try {
          await invoke("write_file", {
            path: canvasPath(venture.rootPath),
            content: JSON.stringify(toSave, null, 2) + "\n",
          });
        } catch (err) {
          pushToast({
            kind: "warn",
            message: "Couldn't save research canvas",
            detail: errDetail(err),
          });
        }
        setSaveStatus("saved");
      }, 800);
    },
    [venture.rootPath]
  );

  const updateCanvas = useCallback(
    (patch: Partial<ResearchCanvas>) => {
      setCanvas((prev) => {
        const next = { ...prev, ...patch };
        scheduleSave(next);
        return next;
      });
    },
    [scheduleSave]
  );

  // Competitor helpers
  const addCompetitor = () => {
    updateCanvas({
      competitors: [...canvas.competitors, { id: makeid(), name: "", weakness: "" }],
    });
  };

  const updateCompetitor = (id: string, patch: Partial<Competitor>) => {
    updateCanvas({
      competitors: canvas.competitors.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    });
  };

  const removeCompetitor = (id: string) => {
    updateCanvas({ competitors: canvas.competitors.filter((c) => c.id !== id) });
  };

  // Evidence type toggle
  const toggleEvidence = (type: EvidenceType) => {
    const current = canvas.evidenceTypes;
    const next = current.includes(type) ? current.filter((t) => t !== type) : [...current, type];
    updateCanvas({ evidenceTypes: next });
  };

  const checks = computeChecks(canvas);
  const doneCount = Object.values(checks).filter(Boolean).length;
  const allDone = doneCount === 6;

  // Document upload
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

  const handleAdvance = async () => {
    if (!allDone || advancing) return;
    setAdvancing(true);
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    try {
      const toSave: ResearchCanvas = { ...canvas, updatedAt: new Date().toISOString() };
      await invoke("write_file", {
        path: canvasPath(venture.rootPath),
        content: JSON.stringify(toSave, null, 2) + "\n",
      });
    } catch (err) {
      pushToast({
        kind: "warn",
        message: "Couldn't save before advancing",
        detail: errDetail(err),
      });
    }
    onAdvanceStage("VALIDATED");
    setAdvancing(false);
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
      const system = `You extract market research information from documents to pre-fill a research canvas.
Only extract information clearly stated. Never invent facts. Return raw JSON only — no markdown, no explanation.
Omit any field where the document has no relevant info.
For competitors, return an array: [{"name":"...","weakness":"..."}]`;
      const fields = {
        marketSummary: "Description of the market and who the buyers are",
        tamEstimate: "Total Addressable Market estimate (number or range)",
        samEstimate: "Serviceable Addressable Market estimate",
        keyMarketGap: "The unmet need or gap in the market",
        competitors: "Array of competitors [{name, weakness}] — their main weakness or gap",
        differentiator: "What makes this different from competitors",
        topProblems: "Top customer problems validated by research",
        customerQuotes: "Direct customer quotes from interviews, forums, or reviews",
        evidenceNotes: "Summary of validation evidence — numbers, sources, key signals",
      };
      const optimizedSystem = await optimize({ prompt: system, context: "research" });
      console.info(
        "[prompt-master] research-extract",
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
        maxTokens: 1500,
        temperature: 0.1,
        onDelta: (d) => {
          responseText += d;
        },
      });
      const jsonMatch =
        responseText.match(/```(?:json)?\s*([\s\S]*?)```/) || responseText.match(/(\{[\s\S]*\})/);
      const result = JSON.parse((jsonMatch ? jsonMatch[1] : responseText).trim()) as Record<
        string,
        unknown
      >;
      const patch: Partial<ResearchCanvas> = {};
      let filled = 0;
      if (typeof result.marketSummary === "string") {
        patch.marketSummary = result.marketSummary;
        filled++;
      }
      if (typeof result.tamEstimate === "string") {
        patch.tamEstimate = result.tamEstimate;
        filled++;
      }
      if (typeof result.samEstimate === "string") {
        patch.samEstimate = result.samEstimate;
        filled++;
      }
      if (typeof result.keyMarketGap === "string") {
        patch.keyMarketGap = result.keyMarketGap;
        filled++;
      }
      if (typeof result.differentiator === "string") {
        patch.differentiator = result.differentiator;
        filled++;
      }
      if (typeof result.topProblems === "string") {
        patch.topProblems = result.topProblems;
        filled++;
      }
      if (typeof result.customerQuotes === "string") {
        patch.customerQuotes = result.customerQuotes;
        filled++;
      }
      if (typeof result.evidenceNotes === "string") {
        patch.evidenceNotes = result.evidenceNotes;
        filled++;
      }
      if (Array.isArray(result.competitors) && result.competitors.length > 0) {
        patch.competitors = (result.competitors as Array<{ name?: string; weakness?: string }>).map(
          (c) => ({
            id: makeid(),
            name: c.name ?? "",
            weakness: c.weakness ?? "",
          })
        );
        filled++;
      }
      if (filled > 0) {
        updateCanvas(patch);
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
            Research Canvas
          </h3>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6B7280" }}>
            Validate your idea with real market data before building anything. Saves automatically.
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
                ? "All must-haves complete — advance to Validated stage"
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
            {advancing ? "Advancing…" : "Advance to Validated →"}
          </button>
        </div>
      </div>

      {/* Two-column layout */}
      <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
        {/* LEFT — questions */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Section 1 — Research Documents */}
          <Section title="1. Research Documents" icon="📎">
            <p style={{ margin: "0 0 8px", fontSize: 12, color: "#6B7280" }}>
              Upload market reports, interview transcripts, competitor screenshots, or any
              supporting research. AI will read them and auto-fill matching fields below. Saved to{" "}
              <code>01_research/uploads/</code>. Supports .txt, .md, .csv, .json and .pdf.
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

          {/* Section 2 — Market Size */}
          <Section title="2. Market Size" icon="📊">
            <Field
              label="Describe the market"
              required
              hint="Who are the buyers? What industry or segment? Be specific."
            >
              <Textarea
                value={canvas.marketSummary}
                onChange={(v) => updateCanvas({ marketSummary: v })}
                placeholder="e.g. UK-based freelancers and independent contractors (est. 4.9m people) who invoice clients for services. Growing 6% YoY as remote work expands."
                rows={3}
              />
              <CharCount value={canvas.marketSummary} min={30} />
            </Field>

            <div style={{ display: "flex", gap: 12 }}>
              <Field
                label="TAM estimate"
                required
                hint="Total Addressable Market"
                style={{ flex: 1 }}
              >
                <input
                  type="text"
                  value={canvas.tamEstimate}
                  onChange={(e) => updateCanvas({ tamEstimate: e.target.value })}
                  placeholder="e.g. £2.4bn/yr"
                  style={inputStyle}
                />
              </Field>
              <Field
                label="SAM estimate"
                hint="Serviceable Addressable Market — realistic slice"
                style={{ flex: 1 }}
              >
                <input
                  type="text"
                  value={canvas.samEstimate}
                  onChange={(e) => updateCanvas({ samEstimate: e.target.value })}
                  placeholder="e.g. £180m/yr"
                  style={inputStyle}
                />
              </Field>
            </div>

            <Field
              label="What's the market gap or unmet need?"
              required
              hint="What problem are existing solutions leaving unsolved?"
            >
              <Textarea
                value={canvas.keyMarketGap}
                onChange={(v) => updateCanvas({ keyMarketGap: v })}
                placeholder="e.g. Existing tools (FreeAgent, QuickBooks) are built for accountants — the UI is too complex for solo freelancers who just want automatic invoice chasing."
                rows={3}
              />
              <CharCount value={canvas.keyMarketGap} min={20} />
            </Field>
          </Section>

          {/* Section 3 — Competitor Analysis */}
          <Section title="3. Competitor Analysis" icon="🔍">
            <p style={{ margin: "0 0 4px", fontSize: 12, color: "#6B7280" }}>
              Add at least 2 direct or indirect competitors. Include their main weakness or where
              they fall short.
            </p>

            {canvas.competitors.map((comp, idx) => (
              <CompetitorRow
                key={comp.id}
                index={idx + 1}
                competitor={comp}
                onChange={(patch) => updateCompetitor(comp.id, patch)}
                onRemove={() => removeCompetitor(comp.id)}
              />
            ))}

            <button
              type="button"
              onClick={addCompetitor}
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
              + Add competitor
            </button>

            <Field
              label="What makes you genuinely different?"
              required
              hint="Your key differentiator vs the competition — be honest, not fluffy."
            >
              <Textarea
                value={canvas.differentiator}
                onChange={(v) => updateCanvas({ differentiator: v })}
                placeholder="e.g. Unlike FreeAgent, we focus only on invoice chasing — fully automated, no manual setup. Designed for non-accountants in under 5 minutes."
                rows={3}
              />
              <CharCount value={canvas.differentiator} min={20} />
            </Field>
          </Section>

          {/* Section 4 — Customer Problems */}
          <Section title="4. Customer Problems" icon="🎯">
            <Field
              label="Top customer problems you've validated"
              required
              hint="List the 2–3 biggest pains your research surfaced — ranked by frequency or severity."
            >
              <Textarea
                value={canvas.topProblems}
                onChange={(v) => updateCanvas({ topProblems: v })}
                placeholder={`e.g.\n1. Chasing late invoices manually takes 3–5 hours/week\n2. Freelancers don't know when to escalate — no system alerts them\n3. Switching to specialist software feels overwhelming`}
                rows={5}
              />
              <CharCount value={canvas.topProblems} min={30} />
            </Field>

            <Field
              label="Direct customer quotes"
              hint="Paste any real quotes from interviews, forums, social media, or reviews that back up the problems above."
            >
              <Textarea
                value={canvas.customerQuotes}
                onChange={(v) => updateCanvas({ customerQuotes: v })}
                placeholder={`e.g. "I've lost thousands to clients who just stop replying — I need something that does the chasing for me so I don't have to feel awkward." — Reddit r/freelance`}
                rows={3}
              />
            </Field>
          </Section>

          {/* Section 5 — Validation Evidence */}
          <Section title="5. Validation Evidence" icon="✅">
            <p style={{ margin: "0 0 8px", fontSize: 12, color: "#6B7280" }}>
              What evidence have you collected that confirms the problem is real and worth solving?
            </p>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
              {EVIDENCE_OPTIONS.map((opt) => {
                const selected = canvas.evidenceTypes.includes(opt.value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => toggleEvidence(opt.value)}
                    style={{
                      padding: "6px 12px",
                      border: `2px solid ${selected ? "#6366F1" : "#E5E7EB"}`,
                      borderRadius: 20,
                      background: selected ? "#EEF2FF" : "#FFFFFF",
                      color: selected ? "#4F46E5" : "#6B7280",
                      fontWeight: selected ? 700 : 500,
                      fontSize: 12,
                      cursor: "pointer",
                      transition: "all 0.15s",
                    }}
                  >
                    {selected ? "✓ " : ""}
                    {opt.label}
                  </button>
                );
              })}
            </div>

            <Field
              label="Evidence notes"
              hint="Summarise what you found — numbers, sources, key signals."
            >
              <Textarea
                value={canvas.evidenceNotes}
                onChange={(v) => updateCanvas({ evidenceNotes: v })}
                placeholder="e.g. 12 interviews conducted — 10/12 confirmed invoice chasing is their #1 admin pain. Reddit thread with 847 upvotes on r/freelance: 'I wish someone would just do this automatically'. Google Trends: 'invoice follow up software' up 34% YoY."
                rows={4}
              />
            </Field>
          </Section>

          {/* Section 6 — Research Summary & Go/No-Go */}
          <Section title="6. Research Summary" icon="📝">
            <Field
              label="Overall research conclusion"
              required
              hint="Summarise what you learned. What did research confirm, challenge, or reveal?"
            >
              <Textarea
                value={canvas.researchSummary}
                onChange={(v) => updateCanvas({ researchSummary: v })}
                placeholder="e.g. Research strongly confirms the problem is real and frequent. The market is large enough, existing tools are weak in this specific area, and 10/12 interviewees said they'd pay for a solution. Main risk: the top 3 competitors could add this feature easily — speed to market matters."
                rows={4}
              />
            </Field>

            <div>
              <p style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 600, color: "#374151" }}>
                Go / No-Go decision <span style={{ color: "#EF4444" }}>*</span>
              </p>
              <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                <GoNoGoButton
                  active={canvas.goNoGo === "go"}
                  onClick={() => updateCanvas({ goNoGo: "go" })}
                  color="#059669"
                  label="✅ Go"
                  sublabel="Validated — building this"
                />
                <GoNoGoButton
                  active={canvas.goNoGo === "undecided"}
                  onClick={() => updateCanvas({ goNoGo: "undecided" })}
                  color="#D97706"
                  label="⏳ Still deciding"
                  sublabel="More research needed"
                />
                <GoNoGoButton
                  active={canvas.goNoGo === "no_go"}
                  onClick={() => updateCanvas({ goNoGo: "no_go" })}
                  color="#DC2626"
                  label="🛑 No-Go"
                  sublabel="Pivoting or stopping"
                />
              </div>
              {canvas.goNoGo !== "undecided" && (
                <Textarea
                  value={canvas.goNoGoReason}
                  onChange={(v) => updateCanvas({ goNoGoReason: v })}
                  placeholder={
                    canvas.goNoGo === "go"
                      ? "What tipped you to Go? e.g. Strong customer pain + clear gap in the market + I can build v1 in 6 weeks."
                      : "Why no-go? What would need to change to revisit this? e.g. Market too small for SaaS — may revisit as a productised service."
                  }
                  rows={2}
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

            {/* Progress bar */}
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
                    ? "Advance to Validated →"
                    : "Complete checklist first"}
              </button>
              {allDone && (
                <p
                  style={{ margin: "8px 0 0", fontSize: 11, color: "#059669", textAlign: "center" }}
                >
                  Research complete! Moves you to VALIDATED.
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
// CompetitorRow
// ---------------------------------------------------------------------------

function CompetitorRow({
  index,
  competitor,
  onChange,
  onRemove,
}: {
  index: number;
  competitor: Competitor;
  onChange: (patch: Partial<Competitor>) => void;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        border: "1px solid #E5E7EB",
        borderRadius: 8,
        padding: "12px 14px",
        background: "#F9FAFB",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", minWidth: 70 }}>
          Competitor {index}
        </span>
        <input
          type="text"
          value={competitor.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Name (e.g. FreeAgent)"
          style={{ ...inputStyle, flex: 1 }}
        />
        <button
          type="button"
          onClick={onRemove}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "#9CA3AF",
            fontSize: 16,
            padding: "2px 6px",
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
        value={competitor.weakness}
        onChange={(e) => onChange({ weakness: e.target.value })}
        placeholder="Their main weakness or gap (e.g. too complex for non-accountants)"
        style={inputStyle}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// GoNoGoButton
// ---------------------------------------------------------------------------

function GoNoGoButton({
  active,
  onClick,
  color,
  label,
  sublabel,
}: {
  active: boolean;
  onClick: () => void;
  color: string;
  label: string;
  sublabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        padding: "10px 8px",
        border: `2px solid ${active ? color : "#E5E7EB"}`,
        borderRadius: 8,
        background: active ? `${color}14` : "#FFFFFF",
        color: active ? color : "#6B7280",
        cursor: "pointer",
        transition: "all 0.15s",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 10, marginTop: 2, opacity: 0.8 }}>{sublabel}</div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Sub-components (shared pattern from IdeaTab)
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
  const config = {
    saved: { color: "#059669", text: "Saved" },
    saving: { color: "#6366F1", text: "Saving…" },
    unsaved: { color: "#D97706", text: "Unsaved" },
  }[status];
  return <span style={{ fontSize: 11, color: config.color, fontWeight: 600 }}>{config.text}</span>;
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

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
