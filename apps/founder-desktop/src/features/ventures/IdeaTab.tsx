import type {
  AppType,
  EntityType,
  Venture,
  VentureManifest,
  VentureStage,
} from "@founder-os/domain";
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

export type IdeaCanvas = {
  // The Problem
  problem: string;
  targetUser: string;
  unfairAdvantage: string;

  // Your Product
  seenBefore: boolean;
  seenBeforeNotes: string;
  monetizationModel: string;

  // Validation
  talkedToCustomers: boolean;
  customerCount: string;
  customerNotes: string;
  hasLandingPage: boolean;
  landingPageUrl: string;
  hasEarlySignups: boolean;
  signupCount: string;
  hasCompetitors: boolean;
  competitorNotes: string;

  // Blockers
  hasBlockers: boolean;
  blockerDetails: string;

  updatedAt: string;
};

type UploadedDoc = {
  id: string;
  name: string;
  savedPath: string;
  sizeKb: number;
};

const DEFAULT_CANVAS: IdeaCanvas = {
  problem: "",
  targetUser: "",
  unfairAdvantage: "",
  seenBefore: false,
  seenBeforeNotes: "",
  monetizationModel: "",
  talkedToCustomers: false,
  customerCount: "",
  customerNotes: "",
  hasLandingPage: false,
  landingPageUrl: "",
  hasEarlySignups: false,
  signupCount: "",
  hasCompetitors: false,
  competitorNotes: "",
  hasBlockers: false,
  blockerDetails: "",
  updatedAt: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Must-haves gate logic
// ---------------------------------------------------------------------------

type CheckKey =
  | "problemDefined"
  | "targetUserDefined"
  | "entityTypeDecided"
  | "monetizationNoted"
  | "validationStarted"
  | "blockersAssessed";

type ChecksMap = Record<CheckKey, boolean>;

function computeChecks(canvas: IdeaCanvas, entityType: EntityType): ChecksMap {
  return {
    problemDefined: canvas.problem.trim().length >= 30,
    targetUserDefined: canvas.targetUser.trim().length >= 15,
    entityTypeDecided: entityType !== "undecided",
    monetizationNoted: canvas.monetizationModel.trim().length >= 10,
    validationStarted: canvas.talkedToCustomers || canvas.hasLandingPage || canvas.hasEarlySignups,
    blockersAssessed: canvas.hasBlockers === false || canvas.blockerDetails.trim().length > 0,
  };
}

const CHECK_LABELS: Record<CheckKey, string> = {
  problemDefined: "Problem defined",
  targetUserDefined: "Target user identified",
  entityTypeDecided: "Business structure decided",
  monetizationNoted: "Monetization model noted",
  validationStarted: "Validation started",
  blockersAssessed: "Blockers assessed",
};

const CHECK_HINTS: Record<CheckKey, string> = {
  problemDefined: "Describe the problem in 30+ characters",
  targetUserDefined: "Who is it for? 15+ characters",
  entityTypeDecided: "Choose your entity type (not Undecided)",
  monetizationNoted: "How will it make money? 10+ characters",
  validationStarted: "Tick at least one validation box below",
  blockersAssessed: "Answer yes/no to blockers — note any details if yes",
};

const ENTITY_OPTIONS: { value: EntityType; label: string }[] = [
  { value: "undecided", label: "Undecided" },
  { value: "sole_trader", label: "Sole Trader" },
  { value: "ltd", label: "Limited Company (Ltd)" },
  { value: "partnership", label: "Partnership" },
];

const APP_OPTIONS: { value: AppType; label: string }[] = [
  { value: "saas", label: "SaaS" },
  { value: "web", label: "Web app" },
  { value: "desktop", label: "Desktop app" },
  { value: "mobile", label: "Mobile app" },
  { value: "browser_extension", label: "Browser extension" },
  { value: "game", label: "Game" },
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
    : `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function canvasPath(rootPath: string): string {
  return joinPath(joinPath(rootPath, "01_research"), "idea-canvas.json");
}

function uploadsDir(rootPath: string): string {
  return joinPath(joinPath(rootPath, "01_research"), "uploads");
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function IdeaTab({
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
  const [canvas, setCanvas] = useState<IdeaCanvas>(DEFAULT_CANVAS);
  const [entityType, setEntityType] = useState<EntityType>(manifest?.entityType ?? "undecided");
  const [appType, setAppType] = useState<AppType>(manifest?.appType ?? "saas");
  const [regulated, setRegulated] = useState(manifest?.regulated ?? false);
  const [takesPayments, setTakesPayments] = useState(manifest?.takesPayments ?? false);
  const [handlesPersonalData, setHandlesPersonalData] = useState(
    manifest?.handlesPersonalData ?? false
  );
  const [hiresStaff, setHiresStaff] = useState(manifest?.hiresStaff ?? false);
  const [uploadedDocs, setUploadedDocs] = useState<UploadedDoc[]>([]);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "unsaved">("saved");
  const [advancing, setAdvancing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [aiFillingDocs, setAiFillingDocs] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Sync manifest fields into local state when manifest changes
  useEffect(() => {
    if (!manifest) return;
    setEntityType(manifest.entityType);
    setAppType(manifest.appType);
    setRegulated(manifest.regulated);
    setTakesPayments(manifest.takesPayments);
    setHandlesPersonalData(manifest.handlesPersonalData);
    setHiresStaff(manifest.hiresStaff);
  }, [manifest?.id]);

  // Load canvas from disk on venture change
  useEffect(() => {
    let cancelled = false;
    const path = canvasPath(venture.rootPath);
    invoke<string>("read_file", { path })
      .then((raw) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(raw) as IdeaCanvas;
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

  // Load uploaded docs list from disk.
  // list_dir returns absolute paths — extract filename for display.
  useEffect(() => {
    let cancelled = false;
    const dir = uploadsDir(venture.rootPath);
    invoke<string[]>("list_dir", { path: dir })
      .then((paths) => {
        if (cancelled) return;
        const docs: UploadedDoc[] = paths
          .map((p) => {
            // Windows: backslash; Unix: forward slash
            const parts = p.replace(/\\/g, "/").split("/");
            const name = parts[parts.length - 1] ?? p;
            return { id: p, name, savedPath: p, sizeKb: 0 };
          })
          .filter((d) => !d.name.startsWith("."));
        setUploadedDocs(docs);
      })
      .catch(() => {
        // dir doesn't exist yet — fine, no docs shown
      });
    return () => {
      cancelled = true;
    };
  }, [venture.id, venture.rootPath]);

  // Debounced save
  const scheduleSave = useCallback(
    (
      nextCanvas: IdeaCanvas,
      nextEntityType: EntityType,
      nextAppType: AppType,
      nextRegulated: boolean,
      nextPayments: boolean,
      nextPersonalData: boolean,
      nextHiresStaff: boolean
    ) => {
      setSaveStatus("unsaved");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        setSaveStatus("saving");
        const canvasToSave: IdeaCanvas = {
          ...nextCanvas,
          updatedAt: new Date().toISOString(),
        };
        try {
          await invoke("write_file", {
            path: canvasPath(venture.rootPath),
            content: JSON.stringify(canvasToSave, null, 2) + "\n",
          });
        } catch (err) {
          pushToast({
            kind: "warn",
            message: "Couldn't save idea canvas",
            detail: errDetail(err),
          });
        }

        // Sync manifest fields
        if (manifest) {
          const updated: VentureManifest = {
            ...manifest,
            entityType: nextEntityType,
            appType: nextAppType,
            regulated: nextRegulated,
            takesPayments: nextPayments,
            handlesPersonalData: nextPersonalData,
            hiresStaff: nextHiresStaff,
          };
          try {
            await writeVentureManifest(venture.rootPath, updated);
            onManifestUpdate(updated);
          } catch (err) {
            pushToast({
              kind: "warn",
              message: "Couldn't update venture.yaml",
              detail: errDetail(err),
            });
          }
        }

        setSaveStatus("saved");
      }, 800);
    },
    [venture.rootPath, manifest, onManifestUpdate]
  );

  // Helpers to update canvas fields + trigger save
  const updateCanvas = useCallback(
    (patch: Partial<IdeaCanvas>) => {
      setCanvas((prev) => {
        const next = { ...prev, ...patch };
        scheduleSave(
          next,
          entityType,
          appType,
          regulated,
          takesPayments,
          handlesPersonalData,
          hiresStaff
        );
        return next;
      });
    },
    [scheduleSave, entityType, appType, regulated, takesPayments, handlesPersonalData, hiresStaff]
  );

  const updateManifestField = useCallback(
    (
      nextEntity: EntityType,
      nextApp: AppType,
      nextReg: boolean,
      nextPay: boolean,
      nextPII: boolean,
      nextHire: boolean
    ) => {
      scheduleSave(canvas, nextEntity, nextApp, nextReg, nextPay, nextPII, nextHire);
    },
    [scheduleSave, canvas]
  );

  const checks = computeChecks(canvas, entityType);
  const doneCount = Object.values(checks).filter(Boolean).length;
  const allDone = doneCount === 6;

  // Document upload
  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    const dir = uploadsDir(venture.rootPath);
    // Ensure the uploads directory exists (may not exist on older ventures
    // created before this dir was added to VENTURE_DIR_SKELETON)
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
          // Extract text via existing pdf_extract_text Rust command
          const buf = await file.arrayBuffer();
          const b64 = arrayBufferToBase64(buf);
          try {
            const extracted = await invoke<string>("pdf_extract_text", { base64Bytes: b64 });
            if (!extracted.trim()) {
              pushToast({
                kind: "warn",
                message: `"${file.name}" appears to be a scanned PDF — text extraction returned empty`,
                ttlMs: 6000,
              });
              continue;
            }
            content = `[Extracted from PDF: ${file.name}]\n\n${extracted}`;
            // Save as .txt so it's readable
            const saveName = file.name.replace(/\.pdf$/i, ".extracted.txt");
            await invoke("write_file", {
              path: joinPath(dir, saveName),
              content: content + "\n",
            });
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
            detail: "Upload .txt, .md, .csv, .json or .pdf files",
            ttlMs: 5000,
          });
          continue;
        }

        await invoke("write_file", {
          path: joinPath(dir, file.name),
          content: content + "\n",
        });
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
    // Force a final save before advancing
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    try {
      const canvasToSave: IdeaCanvas = { ...canvas, updatedAt: new Date().toISOString() };
      await invoke("write_file", {
        path: canvasPath(venture.rootPath),
        content: JSON.stringify(canvasToSave, null, 2) + "\n",
      });
      if (manifest) {
        const updated: VentureManifest = {
          ...manifest,
          entityType,
          appType,
          regulated,
          takesPayments,
          handlesPersonalData,
          hiresStaff,
        };
        await writeVentureManifest(venture.rootPath, updated);
        onManifestUpdate(updated);
      }
    } catch (err) {
      pushToast({
        kind: "warn",
        message: "Couldn't save before advancing",
        detail: errDetail(err),
      });
    }
    onAdvanceStage("RESEARCHED");
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
          /* skip unreadable */
        }
      }
      if (docTexts.length === 0) {
        pushToast({ kind: "warn", message: "Couldn't read any uploaded documents" });
        return;
      }
      const combined = docTexts.join("\n\n---\n\n").slice(0, 15000);
      const system = `You extract startup idea information from documents to pre-fill a canvas form.
Only extract information clearly stated. Never invent facts. Return raw JSON only — no markdown, no explanation.
Omit any field where the document has no relevant info.`;
      const fields = {
        problem: "The core problem being solved (1-3 sentences describing the pain point)",
        targetUser: "Who specifically has this problem — role, demographics, situation",
        unfairAdvantage: "Why the founder is uniquely positioned, or why now is the right time",
        monetizationModel: "How the product will make money (subscription, one-off, etc.)",
        seenBeforeNotes: "Any competitors or similar products mentioned",
        competitorNotes: "Competitor weaknesses or differentiation notes",
        customerNotes: "Any customer insights, feedback, or interview notes",
      };
      const optimizedSystem = await optimize({ prompt: system, context: "research" });
      console.info(
        "[prompt-master] idea-extract",
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
      const patch: Partial<IdeaCanvas> = {};
      let filled = 0;
      if (result.problem) {
        patch.problem = result.problem;
        filled++;
      }
      if (result.targetUser) {
        patch.targetUser = result.targetUser;
        filled++;
      }
      if (result.unfairAdvantage) {
        patch.unfairAdvantage = result.unfairAdvantage;
        filled++;
      }
      if (result.monetizationModel) {
        patch.monetizationModel = result.monetizationModel;
        filled++;
      }
      if (result.seenBeforeNotes) {
        patch.seenBeforeNotes = result.seenBeforeNotes;
        patch.seenBefore = true;
        filled++;
      }
      if (result.competitorNotes) {
        patch.competitorNotes = result.competitorNotes;
        patch.hasCompetitors = true;
        filled++;
      }
      if (result.customerNotes) {
        patch.customerNotes = result.customerNotes;
        patch.talkedToCustomers = true;
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
      {/* Top header bar */}
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
            Idea Canvas
          </h3>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6B7280" }}>
            Work through these questions to get from idea to research-ready. Saves automatically.
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
                ? "All must-haves complete — advance to Research stage"
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
            {advancing ? "Advancing…" : "Advance to Research →"}
          </button>
        </div>
      </div>

      {/* Layout: checklist card + content */}
      <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
        {/* LEFT — scrollable questions */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Section 1 — Supporting Documents */}
          <Section title="1. Supporting Documents" icon="📎">
            <p style={{ margin: "0 0 8px", fontSize: 12, color: "#6B7280" }}>
              Upload any documents you've already prepared — notes, research, business plans, ideas.
              AI will read them and auto-fill matching fields below. Saved to{" "}
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
                      style={{ ...iconBtnStyle, color: "#6366F1" }}
                      title="Open in file manager"
                    >
                      ↗
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Section 2 — The Problem */}
          <Section title="2. The Problem" icon="💡">
            <Field
              label="What problem are you solving?"
              required
              hint="Be specific — good answers are 1–3 sentences about the pain, not the solution."
            >
              <Textarea
                value={canvas.problem}
                onChange={(v) => updateCanvas({ problem: v })}
                placeholder="e.g. Freelancers spend 3–4 hours a week chasing overdue invoices because their accounting tools don't automate follow-ups."
                rows={4}
              />
              <CharCount value={canvas.problem} min={30} />
            </Field>
            <Field
              label="Who is it for?"
              required
              hint="Describe the specific person with this problem — job title, company size, situation."
            >
              <Textarea
                value={canvas.targetUser}
                onChange={(v) => updateCanvas({ targetUser: v })}
                placeholder="e.g. UK-based freelance developers and designers earning £30–80k/yr who invoice 3–10 clients at a time."
                rows={3}
              />
              <CharCount value={canvas.targetUser} min={15} />
            </Field>
            <Field
              label="What's your unfair advantage or why now?"
              hint="Why are you the right person, or why is this the right moment?"
            >
              <Textarea
                value={canvas.unfairAdvantage}
                onChange={(v) => updateCanvas({ unfairAdvantage: v })}
                placeholder="e.g. I've been a freelancer for 5 years and built this exact workflow in spreadsheets. The new UK MTD mandate creates urgency."
                rows={3}
              />
            </Field>
          </Section>

          {/* Section 3 — Your Product */}
          <Section title="3. Your Product" icon="🛠️">
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <Field label="Product type" style={{ flex: 1, minWidth: 160 }}>
                <select
                  value={appType}
                  onChange={(e) => {
                    const v = e.target.value as AppType;
                    setAppType(v);
                    updateManifestField(
                      entityType,
                      v,
                      regulated,
                      takesPayments,
                      handlesPersonalData,
                      hiresStaff
                    );
                  }}
                  style={selectStyle}
                >
                  {APP_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field
              label="How will it make money?"
              required
              hint="Subscription, one-off purchase, usage-based, marketplace cut, freemium…"
            >
              <Textarea
                value={canvas.monetizationModel}
                onChange={(v) => updateCanvas({ monetizationModel: v })}
                placeholder="e.g. Monthly SaaS subscription — £9/mo solo, £29/mo team. No free tier in v1."
                rows={2}
              />
              <CharCount value={canvas.monetizationModel} min={10} />
            </Field>

            <CheckRow
              checked={canvas.seenBefore}
              onChange={(v) => updateCanvas({ seenBefore: v })}
              label="Have you seen this done before? (direct or close competitors)"
            >
              {canvas.seenBefore && (
                <Textarea
                  value={canvas.seenBeforeNotes}
                  onChange={(v) => updateCanvas({ seenBeforeNotes: v })}
                  placeholder="Who? Why is yours different or better? What's their weakness?"
                  rows={2}
                />
              )}
            </CheckRow>
          </Section>

          {/* Section 4 — Business Setup */}
          <Section title="4. Business Setup" icon="🏢">
            <p style={{ margin: "0 0 12px", fontSize: 12, color: "#6B7280" }}>
              These shape compliance requirements later (UK setup, ICO, insurance). You can change
              them any time.
            </p>
            <Field label="UK entity type" required>
              <select
                value={entityType}
                onChange={(e) => {
                  const v = e.target.value as EntityType;
                  setEntityType(v);
                  updateManifestField(
                    v,
                    appType,
                    regulated,
                    takesPayments,
                    handlesPersonalData,
                    hiresStaff
                  );
                }}
                style={{
                  ...selectStyle,
                  borderColor: entityType === "undecided" ? "#FCD34D" : "#D1D5DB",
                }}
              >
                {ENTITY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {entityType === "undecided" && (
                <span style={{ fontSize: 11, color: "#D97706", marginTop: 4 }}>
                  Required for the checklist — choose even provisionally
                </span>
              )}
            </Field>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
              <ToggleRow
                checked={regulated}
                onChange={(v) => {
                  setRegulated(v);
                  updateManifestField(
                    entityType,
                    appType,
                    v,
                    takesPayments,
                    handlesPersonalData,
                    hiresStaff
                  );
                }}
                label="Regulated industry?"
                hint="Finance, healthcare, legal, insurance, gambling, childcare, alcohol, pharmacy…"
              />
              <ToggleRow
                checked={takesPayments}
                onChange={(v) => {
                  setTakesPayments(v);
                  updateManifestField(
                    entityType,
                    appType,
                    regulated,
                    v,
                    handlesPersonalData,
                    hiresStaff
                  );
                }}
                label="Takes payments from customers?"
                hint="Triggers PCI, payment processor setup, consumer protections"
              />
              <ToggleRow
                checked={handlesPersonalData}
                onChange={(v) => {
                  setHandlesPersonalData(v);
                  updateManifestField(entityType, appType, regulated, takesPayments, v, hiresStaff);
                }}
                label="Handles personal data (names, emails, addresses, behavioural data…)?"
                hint="Triggers ICO data protection fee, GDPR obligations, Privacy Policy"
              />
              <ToggleRow
                checked={hiresStaff}
                onChange={(v) => {
                  setHiresStaff(v);
                  updateManifestField(
                    entityType,
                    appType,
                    regulated,
                    takesPayments,
                    handlesPersonalData,
                    v
                  );
                }}
                label="Plans to hire staff or contractors?"
                hint="Triggers employers' liability insurance (£5m min), PAYE, employment contracts"
              />
            </div>
          </Section>

          {/* Section 5 — Validation */}
          <Section title="5. Validation So Far" icon="✅">
            <p style={{ margin: "0 0 12px", fontSize: 12, color: "#6B7280" }}>
              Tick anything you've done. At least one is needed to advance.
            </p>

            <CheckRow
              checked={canvas.talkedToCustomers}
              onChange={(v) => updateCanvas({ talkedToCustomers: v })}
              label="Talked to potential customers"
            >
              {canvas.talkedToCustomers && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <label style={{ fontSize: 12, color: "#374151", whiteSpace: "nowrap" }}>
                      How many?
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={canvas.customerCount}
                      onChange={(e) => updateCanvas({ customerCount: e.target.value })}
                      style={{ ...inputStyle, width: 80 }}
                      placeholder="0"
                    />
                  </div>
                  <Textarea
                    value={canvas.customerNotes}
                    onChange={(v) => updateCanvas({ customerNotes: v })}
                    placeholder="Key takeaways from those conversations…"
                    rows={2}
                  />
                </div>
              )}
            </CheckRow>

            <CheckRow
              checked={canvas.hasLandingPage}
              onChange={(v) => updateCanvas({ hasLandingPage: v })}
              label="Landing page or waitlist live"
            >
              {canvas.hasLandingPage && (
                <input
                  type="url"
                  value={canvas.landingPageUrl}
                  onChange={(e) => updateCanvas({ landingPageUrl: e.target.value })}
                  style={inputStyle}
                  placeholder="https://yourproduct.com"
                />
              )}
            </CheckRow>

            <CheckRow
              checked={canvas.hasEarlySignups}
              onChange={(v) => updateCanvas({ hasEarlySignups: v })}
              label="Have early sign-ups or expressed interest"
            >
              {canvas.hasEarlySignups && (
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <label style={{ fontSize: 12, color: "#374151", whiteSpace: "nowrap" }}>
                    How many?
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={canvas.signupCount}
                    onChange={(e) => updateCanvas({ signupCount: e.target.value })}
                    style={{ ...inputStyle, width: 80 }}
                    placeholder="0"
                  />
                </div>
              )}
            </CheckRow>

            <CheckRow
              checked={canvas.hasCompetitors}
              onChange={(v) => updateCanvas({ hasCompetitors: v })}
              label="Competitors or alternatives exist"
            >
              {canvas.hasCompetitors && (
                <Textarea
                  value={canvas.competitorNotes}
                  onChange={(v) => updateCanvas({ competitorNotes: v })}
                  placeholder="Name the main ones and your key difference…"
                  rows={2}
                />
              )}
            </CheckRow>
          </Section>

          {/* Section 6 — Blockers */}
          <Section title="6. Blockers" icon="🚧">
            <p style={{ margin: "0 0 12px", fontSize: 12, color: "#6B7280" }}>
              Being honest about blockers now prevents wasted effort later.
            </p>
            <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
              <ChoiceButton
                active={canvas.hasBlockers === false}
                onClick={() => updateCanvas({ hasBlockers: false, blockerDetails: "" })}
                color="#059669"
              >
                No blockers right now
              </ChoiceButton>
              <ChoiceButton
                active={canvas.hasBlockers === true}
                onClick={() => updateCanvas({ hasBlockers: true })}
                color="#D97706"
              >
                Yes, I have blockers
              </ChoiceButton>
            </div>
            {canvas.hasBlockers && (
              <Textarea
                value={canvas.blockerDetails}
                onChange={(v) => updateCanvas({ blockerDetails: v })}
                placeholder="What's blocking you? e.g. Need a co-founder with backend skills / Unsure about FCA authorisation / Need to test if people will pay before building."
                rows={3}
              />
            )}
          </Section>
        </div>

        {/* RIGHT — sticky must-haves checklist */}
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
                    ? "Advance to Research →"
                    : "Complete checklist first"}
              </button>
              {allDone && (
                <p
                  style={{ margin: "8px 0 0", fontSize: 11, color: "#059669", textAlign: "center" }}
                >
                  All set! This moves you to the RESEARCHED stage.
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

function CheckRow({
  checked,
  onChange,
  label,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <label
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          style={{ marginTop: 2, width: 15, height: 15, accentColor: "#6366F1", flexShrink: 0 }}
        />
        <span style={{ fontSize: 13, color: "#111827", lineHeight: 1.4 }}>{label}</span>
      </label>
      {checked && children && (
        <div style={{ marginLeft: 25, display: "flex", flexDirection: "column", gap: 6 }}>
          {children}
        </div>
      )}
    </div>
  );
}

function ToggleRow({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "10px 12px",
        border: "1px solid #E5E7EB",
        borderRadius: 6,
        background: checked ? "#EEF2FF" : "#F9FAFB",
        cursor: "pointer",
        userSelect: "none",
        transition: "background 0.15s",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 2, width: 15, height: 15, accentColor: "#6366F1", flexShrink: 0 }}
      />
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{label}</div>
        {hint && <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 2 }}>{hint}</div>}
      </div>
    </label>
  );
}

function ChoiceButton({
  active,
  onClick,
  color,
  children,
}: {
  active: boolean;
  onClick: () => void;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "8px 14px",
        border: `2px solid ${active ? color : "#E5E7EB"}`,
        borderRadius: 6,
        background: active ? `${color}14` : "#FFFFFF",
        color: active ? color : "#6B7280",
        fontWeight: active ? 700 : 500,
        fontSize: 13,
        cursor: "pointer",
        transition: "all 0.15s",
      }}
    >
      {children}
    </button>
  );
}

function ChecklistItem({
  done,
  label,
  hint,
}: {
  done: boolean;
  label: string;
  hint: string;
}) {
  return (
    <div
      title={done ? "Complete" : hint}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        marginBottom: 10,
      }}
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
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  width: "100%",
};

const iconBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: 14,
  padding: "2px 4px",
  borderRadius: 4,
};

// ---------------------------------------------------------------------------
// Utility — base64 encode ArrayBuffer (same pattern as chat-attachments.ts)
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
