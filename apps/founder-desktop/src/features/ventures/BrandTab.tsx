import { materializeBrandPack } from "@founder-os/branding-assets";
import {
  type AvailabilityCheck,
  type AvailabilityStatus,
  type BrandBrief,
  BrandBriefSchema,
  type BrandPersonality,
  BrandPersonalitySchema,
  type ColorPalette,
  DEFAULT_DOMAIN_TLDS,
  type NamingCandidate,
  type NamingScan,
  NamingScanSchema,
  SOCIAL_PLATFORMS,
  SOCIAL_PLATFORM_LABELS,
  type SocialPlatform,
  TRADEMARK_JURISDICTIONS,
  TRADEMARK_JURISDICTION_LABELS,
  type TrademarkJurisdiction,
  type Typography,
  createEmptyCandidate,
  createEmptyNamingScan,
  deriveBrandConfidence,
  socialProfileUrl,
  trademarkSearchUrl,
} from "@founder-os/branding-core";
import type { Venture, VentureManifest, VentureStage } from "@founder-os/domain";
import type { LlmProviderId } from "@founder-os/llm-providers";
import { optimize } from "@founder-os/prompt-master";
import {
  getBrandKitDir,
  getBrandNamesDir,
  getLogoConceptsDir,
  getLogoExportsDir,
  getStagePath,
} from "@founder-os/workspace-core";
import { invoke } from "@tauri-apps/api/core";
/**
 * Brand tab — covers the four phases of the BRAND_READY stage:
 *   1. Name        — candidates + live availability checks + confidence
 *   2. Direction   — personality / palette / typography / tone
 *   3. Logo        — deterministic SVG pack + AI concept briefs
 *   4. Brand Pack  — summary of what's on disk, exports, open-folder
 *
 * Wiring:
 *   - Canvas (UI-mutable state) is persisted to `03_brand/brand-canvas.json`
 *     with an 800ms debounced autosave, matching ValidationTab.
 *   - The validated brand-brief (`03_brand/brand-kit/brand-brief.json`) is
 *     derived from the canvas via "Save brief" — that's the step the rest
 *     of the pipeline reads, and it's schema-parsed through Zod so we
 *     catch missing/malformed fields at save time.
 *   - The naming scan (`03_brand/names/name-candidates.json`) is its own
 *     file with its own schema; the canvas just holds the chosen
 *     candidate id + a local cache.
 *
 * Strict gate for BRAND_READY:
 *   1. Chosen name set
 *   2. All 7 palette hex values valid
 *   3. ≥1 personality selected
 *   4. Tagline / mission / audience each ≥20 chars
 *   5. brand-brief.json exists
 *   6. logo.svg + tokens.json exist
 */
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type BrandAssetSpec,
  type BrandGenBrief,
  FULL_PACK_SPECS,
  type LogoArchetype,
  type LogoCandidate,
  type PackAssetResult,
  extractPaletteFromSvg,
  generateFullPack,
  generateLogoCandidates,
} from "../../lib/brand-gen.js";
import { pickActiveProvider, streamChat } from "../../lib/llm-client.js";
import { pushToast } from "../../lib/toasts.js";
import { useAbortableTask } from "../../lib/use-abortable-task.js";
import { joinPath } from "../../lib/venture-io.js";
import { ProviderPickerDialog } from "./ProviderPickerDialog.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Canvas = the mutable UI state. Stored alongside the derived brief so
 * the tab can round-trip WIP state even when the brief isn't ready to
 * validate. Keeping these separate is a pt.14-style tripwire — the
 * canvas can hold partial / invalid data without corrupting the
 * schema-checked brief.
 */
type BrandCanvas = {
  tagline: string;
  mission: string;
  targetAudience: string;
  personality: BrandPersonality[];
  toneOfVoice: string;
  competitors: string[];
  differentiators: string[];
  palette: ColorPalette;
  typography: Typography;
  /** Free-form designer brief overrides — NOT validated, NOT persisted to the brief. */
  notes: string;
  updatedAt: string;
};

const DEFAULT_PALETTE: ColorPalette = {
  primary: "#6366F1",
  secondary: "#8B5CF6",
  accent: "#F59E0B",
  background: "#FFFFFF",
  surface: "#F9FAFB",
  text: "#111827",
  textMuted: "#6B7280",
};

/** Preset palettes — keyed by "mood" for one-click apply. */
const PRESET_PALETTES: Record<string, { label: string; palette: ColorPalette }> = {
  bold: {
    label: "Bold",
    palette: {
      primary: "#FF3B30",
      secondary: "#FF6B35",
      accent: "#FFD60A",
      background: "#FFFFFF",
      surface: "#F5F5F5",
      text: "#1C1C1E",
      textMuted: "#6C6C70",
    },
  },
  minimal: {
    label: "Minimal",
    palette: {
      primary: "#000000",
      secondary: "#333333",
      accent: "#0066CC",
      background: "#FFFFFF",
      surface: "#F2F2F7",
      text: "#1C1C1E",
      textMuted: "#8E8E93",
    },
  },
  playful: {
    label: "Playful",
    palette: {
      primary: "#5E5CE6",
      secondary: "#FF6EAB",
      accent: "#30D158",
      background: "#FFFFFF",
      surface: "#F2F2F7",
      text: "#1C1C1E",
      textMuted: "#8E8E93",
    },
  },
  technical: {
    label: "Technical",
    palette: {
      primary: "#0A84FF",
      secondary: "#30D158",
      accent: "#FF9F0A",
      background: "#000000",
      surface: "#1C1C1E",
      text: "#FFFFFF",
      textMuted: "#8E8E93",
    },
  },
};

const DEFAULT_TYPOGRAPHY: Typography = {
  headingFont: "Inter",
  bodyFont: "Inter",
  monoFont: "JetBrains Mono",
  headingWeight: 700,
  bodyWeight: 400,
  scaleBase: 16,
};

const PERSONALITIES: BrandPersonality[] = [
  "bold",
  "minimal",
  "playful",
  "serious",
  "warm",
  "technical",
  "luxe",
  "community",
];

const FONT_SUGGESTIONS = [
  "Inter",
  "Manrope",
  "Plus Jakarta Sans",
  "DM Sans",
  "Figtree",
  "Space Grotesk",
  "Geist",
  "IBM Plex Sans",
  "Playfair Display",
  "Fraunces",
  "Source Serif 4",
  "Instrument Serif",
] as const;

function defaultCanvas(manifest: VentureManifest | null): BrandCanvas {
  const industry = manifest?.industry ?? "";
  return {
    tagline: "",
    mission: "",
    targetAudience: industry ? `Founders building ${industry} products` : "",
    personality: [],
    toneOfVoice: "",
    competitors: [],
    differentiators: [],
    palette: { ...DEFAULT_PALETTE },
    typography: { ...DEFAULT_TYPOGRAPHY },
    notes: "",
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function canvasPath(rootPath: string): string {
  return joinPath(getStagePath(rootPath, "brand"), "brand-canvas.json");
}
function briefPath(rootPath: string): string {
  return joinPath(getBrandKitDir(rootPath), "brand-brief.json");
}
function namingScanPath(rootPath: string): string {
  return joinPath(getBrandNamesDir(rootPath), "name-candidates.json");
}
function logoSvgPath(rootPath: string): string {
  return joinPath(getLogoExportsDir(rootPath), "logo.svg");
}
function tokensJsonPath(rootPath: string): string {
  return joinPath(getLogoExportsDir(rootPath), "tokens.json");
}

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

const HEX6_RE = /^#[0-9A-Fa-f]{6}$/;
function isValidHex(v: string): boolean {
  return HEX6_RE.test(v.trim());
}

/**
 * Relative luminance per WCAG 2.1. `hex` must be #rrggbb.
 * Returns 0..1.
 */
function relativeLuminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG 2.1 contrast ratio between two hex colors. */
function contrastRatio(a: string, b: string): number {
  if (!isValidHex(a) || !isValidHex(b)) return 0;
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// ---------------------------------------------------------------------------
// Logo concept specs (pt.31a)
// ---------------------------------------------------------------------------
//
// Hoisted to module-level so both `handleGenerateConcepts` (the bulk
// "Generate 4 concept briefs" button) and `handleRegenerateConcept`
// (per-tile single-concept regen) can reference the same spec set.
// Filenames double as identifiers — the BrandTab's concepts list maps
// from on-disk filename to spec via a lookup over this array.

type ConceptSpec = {
  filename: string;
  title: string;
  direction: string;
};

const CONCEPT_SPECS: readonly ConceptSpec[] = [
  {
    filename: "concept-01-geometric.md",
    title: "Concept 01 — Geometric Mark",
    direction:
      "An abstract geometric icon + wordmark. Specific shapes, angles, proportions. Avoid cliché (no lightbulbs / rockets / puzzle pieces).",
  },
  {
    filename: "concept-02-letterform.md",
    title: "Concept 02 — Letterform Monogram",
    direction:
      "A single letter or 2-letter monogram as the primary mark. Custom drawn, not set in a typeface. Reference 1-2 anchors (e.g. Airbnb's A, Dropbox's D) and state how it'll differ.",
  },
  {
    filename: "concept-03-metaphor.md",
    title: "Concept 03 — Metaphor",
    direction:
      "A concrete object or creature that symbolises the brand's core promise. Stylised and confident, not a mascot.",
  },
  {
    filename: "concept-04-typographic.md",
    title: "Concept 04 — Typographic Treatment",
    direction:
      "Whole brand name as the logo, no icon. Custom lettering, ligature, swash, or distinctive punctuation. Name the small-size fallback mark.",
  },
] as const;

/**
 * pt.31a: hoisted concept system prompt builder. Both handlers
 * (`handleGenerateConcepts` for the bulk button, `handleRegenerateConcept`
 * for per-tile regen) build the same prompt — single source of truth so
 * a change in tone/voice rules lands in both paths.
 */
function buildConceptSystemPrompt(
  brief: {
    companyName: string;
    tagline: string;
    mission: string;
    targetAudience: string;
    personality: string[];
    toneOfVoice: string;
    colorPalette: { primary: string; accent: string };
    typography: { headingFont: string };
  },
  appType: string | undefined
): string {
  return `You are writing logo concept briefs for "${brief.companyName}" (a ${appType ?? "venture"}).

Tagline: ${brief.tagline}
Mission: ${brief.mission}
Audience: ${brief.targetAudience}
Personality: ${brief.personality.join(", ")}
Tone: ${brief.toneOfVoice}
Primary colour: ${brief.colorPalette.primary} · Accent: ${brief.colorPalette.accent}
Heading font: ${brief.typography.headingFont}

Output rules:
- Markdown. H1 title first, TL;DR paragraph, then body sections.
- Specific not fluffy. "A bold mark" is not a brief — describe proportions, angles, weight.
- Reference 2-3 real brands as tonal anchors and state how THIS will differ.
- Address mono + 16px behaviour.
- 400-700 words total.

Required H2 sections (in order):
1. TL;DR
2. Concept
3. Execution notes
4. Reference anchors
5. Monochrome & small-size behaviour
6. Risks`;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function BrandTab({
  venture,
  manifest,
  onAdvanceStage,
}: {
  venture: Venture;
  manifest: VentureManifest | null;
  onAdvanceStage: (stage: VentureStage) => void;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onManifestUpdate?: (m: VentureManifest) => void;
}) {
  // ── Canvas state ────────────────────────────────────────────────────
  const [canvas, setCanvas] = useState<BrandCanvas>(() => defaultCanvas(manifest));
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "unsaved">("saved");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Naming scan state ───────────────────────────────────────────────
  const [scan, setScan] = useState<NamingScan>(() => createEmptyNamingScan(venture.id));
  const [newCandidateName, setNewCandidateName] = useState("");
  const [aiGenNames, setAiGenNames] = useState(false);
  const [aiSeedHints, setAiSeedHints] = useState("");
  const [checking, setChecking] = useState<Record<string, boolean>>({});

  // ── Derived artifact presence ───────────────────────────────────────
  const [hasBrief, setHasBrief] = useState(false);
  const [hasLogo, setHasLogo] = useState(false);
  const [hasTokens, setHasTokens] = useState(false);
  const [concepts, setConcepts] = useState<string[]>([]);

  // ── Action state ────────────────────────────────────────────────────
  const [savingBrief, setSavingBrief] = useState(false);
  const [generatingLogo, setGeneratingLogo] = useState(false);
  const [generatingConcepts, setGeneratingConcepts] = useState(false);
  // pt.31a: per-filename optimistic flag — null when nothing is in
  // flight, otherwise the filename of the concept currently regenerating.
  // Drives the per-tile button label / disabled state. Only one concept
  // can regenerate at a time (no UI affordance to fire two in parallel).
  const [regeneratingConcept, setRegeneratingConcept] = useState<string | null>(null);
  // pt.32b: abort plumbing for the active regen. Lets the user click ✕
  // to cancel a slow concept regen. The hook bundles the controller +
  // stopping flag + cancel discriminator (same shape used by pipeline
  // and reports). No "Stopping…" middle state here — when the user
  // clicks cancel we go straight from regenerating → idle (toast + ↻).
  const regenTask = useAbortableTask();
  const [advancing, setAdvancing] = useState(false);

  // ── Section open/closed (all open by default on first render) ───────
  const [openSections, setOpenSections] = useState({
    name: true,
    direction: true,
    logo: true,
    aiCandidates: true,
    fullPack: true,
    pack: true,
  });

  // ── AI logo candidates + lock + full pack state ─────────────────────
  //
  // The new brand-pack flow lives in three stages driven by this state:
  //   1. `logoCandidates` holds the 4 AI-generated SVG candidates.
  //      While a generation is in flight, `generatingCandidates` flips on
  //      and the SubscribeDialog-style picker opens via `pickerOpen`.
  //   2. `chosenLogoSvg` captures the user's pick. On pick we also
  //      extract unique colours via `extractPaletteFromSvg` and splice
  //      them into `canvas.palette` so the lock gate has matching brand
  //      colours for pack generation.
  //   3. `brandLocked` gates the "Generate full pack" button. Both the
  //      chosen logo and the palette must be reviewed before we start
  //      rolling email headers / social banners / guide MD.
  const [logoCandidates, setLogoCandidates] = useState<(LogoCandidate & { error?: string })[]>([]);
  const [generatingCandidates, setGeneratingCandidates] = useState(false);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [chosenLogoSvg, setChosenLogoSvg] = useState<string>("");
  const [chosenLogoArchetype, setChosenLogoArchetype] = useState<LogoArchetype | null>(null);
  const [brandLocked, setBrandLocked] = useState(false);

  // Full-pack generation progress — one entry per FULL_PACK_SPECS asset.
  // Status transitions: idle → running → done | error. Content on `done`
  // is the asset body (SVG/HTML/MD); on error `error` holds the message.
  type PackEntryStatus = "idle" | "running" | "done" | "error";
  type PackEntry = {
    spec: BrandAssetSpec;
    status: PackEntryStatus;
    content?: string;
    error?: string;
  };
  const [packEntries, setPackEntries] = useState<PackEntry[]>([]);
  const [generatingPack, setGeneratingPack] = useState(false);
  const [packError, setPackError] = useState<string | null>(null);
  const [packZipPath, setPackZipPath] = useState<string | null>(null);

  // Provider picker — used for BOTH logo-candidate generation and
  // full-pack generation. `pickerIntent` records which action to fire
  // on confirm so one dialog serves both flows.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerIntent, setPickerIntent] = useState<"logo-candidates" | "full-pack" | null>(null);

  const chosenCandidate = useMemo(
    () => scan.candidates.find((c) => c.id === scan.chosenCandidateId) ?? null,
    [scan]
  );
  const chosenName = chosenCandidate?.name ?? "";

  // ── Load canvas / scan / artifacts on venture switch ────────────────
  useEffect(() => {
    let cancelled = false;

    // Canvas
    invoke<string>("read_file", { path: canvasPath(venture.rootPath) })
      .then((raw) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(raw);
          setCanvas({ ...defaultCanvas(manifest), ...parsed });
        } catch {
          setCanvas(defaultCanvas(manifest));
        }
      })
      .catch(() => {
        if (!cancelled) setCanvas(defaultCanvas(manifest));
      });

    // Scan
    invoke<string>("read_file", { path: namingScanPath(venture.rootPath) })
      .then((raw) => {
        if (cancelled) return;
        try {
          const parsed = NamingScanSchema.parse(JSON.parse(raw));
          setScan(parsed);
        } catch (err) {
          // A corrupt scan is worse than none — surface it.
          pushToast({
            kind: "warn",
            message: "Couldn't load name candidates",
            detail: errDetail(err),
          });
          setScan(createEmptyNamingScan(venture.id));
        }
      })
      .catch(() => {
        if (!cancelled) setScan(createEmptyNamingScan(venture.id));
      });

    // Artifacts presence (don't gate the tab render on these; they fill in)
    refreshArtifacts(venture.rootPath);

    return () => {
      cancelled = true;
    };
    // manifest intentionally omitted — a manifest that loads later
    // shouldn't stomp a canvas the user has started editing. Industry
    // default only applies on fresh canvas load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venture.id, venture.rootPath]);

  const refreshArtifacts = useCallback(async (rootPath: string) => {
    try {
      const [brief, logo, tokens] = await Promise.all([
        invoke<boolean>("path_exists", { path: briefPath(rootPath) }),
        invoke<boolean>("path_exists", { path: logoSvgPath(rootPath) }),
        invoke<boolean>("path_exists", { path: tokensJsonPath(rootPath) }),
      ]);
      setHasBrief(brief);
      setHasLogo(logo);
      setHasTokens(tokens);
    } catch {
      /* non-fatal */
    }
    // Concepts directory scan
    try {
      const paths = await invoke<string[]>("list_dir", {
        path: getLogoConceptsDir(rootPath),
      });
      const names = paths
        .map((p) => p.replace(/\\/g, "/").split("/").pop() ?? p)
        .filter((n) => n.endsWith(".md"));
      setConcepts(names.sort());
    } catch {
      setConcepts([]);
    }
  }, []);

  // ── Debounced canvas save ───────────────────────────────────────────
  const scheduleCanvasSave = useCallback(
    (next: BrandCanvas) => {
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
          setSaveStatus("saved");
        } catch (err) {
          setSaveStatus("unsaved");
          pushToast({
            kind: "warn",
            message: "Couldn't save brand canvas",
            detail: errDetail(err),
          });
        }
      }, 800);
    },
    [venture.rootPath]
  );

  const updateCanvas = useCallback(
    (patch: Partial<BrandCanvas>) => {
      setCanvas((prev) => {
        const next = { ...prev, ...patch };
        scheduleCanvasSave(next);
        return next;
      });
    },
    [scheduleCanvasSave]
  );

  const updatePalette = (patch: Partial<ColorPalette>) => {
    updateCanvas({ palette: { ...canvas.palette, ...patch } });
  };
  const updateTypography = (patch: Partial<Typography>) => {
    updateCanvas({ typography: { ...canvas.typography, ...patch } });
  };

  // ── Scan persistence (no debounce — fire-and-forget) ────────────────
  const saveScan = useCallback(
    async (next: NamingScan) => {
      try {
        await invoke("write_file", {
          path: namingScanPath(venture.rootPath),
          content: JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 2) + "\n",
        });
      } catch (err) {
        pushToast({
          kind: "warn",
          message: "Couldn't save name scan",
          detail: errDetail(err),
        });
      }
    },
    [venture.rootPath]
  );

  const updateScan = useCallback(
    (updater: (prev: NamingScan) => NamingScan) => {
      setScan((prev) => {
        const next = updater(prev);
        saveScan(next);
        return next;
      });
    },
    [saveScan]
  );

  const updateCandidate = (id: string, patch: Partial<NamingCandidate>) => {
    updateScan((prev) => ({
      ...prev,
      candidates: prev.candidates.map((c) =>
        c.id === id ? { ...c, ...patch, updatedAt: new Date().toISOString() } : c
      ),
    }));
  };

  // ── Section: NAMING — AI generate ───────────────────────────────────
  const handleAiGenerateNames = async () => {
    if (aiGenNames) return;
    setAiGenNames(true);
    try {
      const providerId = await pickActiveProvider(venture.id);
      if (!providerId) {
        pushToast({
          kind: "warn",
          message: "No AI provider configured",
          detail: "Open Options to add an API key.",
        });
        return;
      }
      const m = manifest;
      const ventureBits = [
        `Venture: ${venture.name}`,
        m ? `App type: ${m.appType}` : null,
        m?.industry ? `Industry: ${m.industry}` : null,
        m?.regulated ? "Regulated: yes" : null,
        m?.takesPayments ? "Takes payments: yes" : null,
        aiSeedHints.trim() ? `Founder hints: ${aiSeedHints.trim()}` : null,
      ]
        .filter(Boolean)
        .join("\n");

      const system = `You are a brand strategist generating venture name candidates.
Return a fenced JSON block with this exact shape:

\`\`\`json
{
  "candidates": [
    { "name": "Lumencore", "style": "compound", "rationale": "1-2 sentences" }
  ]
}
\`\`\`

Rules:
- Return 8 candidates total.
- Mix styles: compound, invented, descriptive, metaphor, acronym (at least 3 distinct).
- 3-14 chars each, single word, no spaces.
- Rationale is concrete (etymology, mental hook), not marketing fluff.
- UK context: don't clash with well-known UK brands.
- Return ONLY the JSON block. No preamble, no commentary.`;

      const optimizedSystem = await optimize({
        prompt: system,
        context: "wireframe",
        ventureId: venture.id,
      });
      console.info(
        "[prompt-master] brand-naming",
        optimizedSystem.fallbackUsed
          ? "(fallback — transport unavailable)"
          : `tokensSaved=${optimizedSystem.tokensSaved} cacheHit=${optimizedSystem.cacheHit}`
      );
      let response = "";
      await streamChat({
        provider: providerId,
        messages: [
          {
            role: "user",
            content: `Generate 8 name candidates.\n\n${ventureBits}\n\nReturn JSON only.`,
          },
        ],
        system: optimizedSystem.optimized,
        maxTokens: 1200,
        temperature: 0.7,
        onDelta: (d) => {
          response += d;
        },
      });

      const parsed = extractCandidatesFromResponse(response);
      if (parsed.length === 0) {
        pushToast({
          kind: "warn",
          message: "AI returned no valid candidates",
          detail: "Response didn't parse — try again or lower the temperature.",
        });
        return;
      }

      // Merge — dedup by lowercase name.
      updateScan((prev) => {
        const seen = new Set(prev.candidates.map((c) => c.name.toLowerCase()));
        const added: NamingCandidate[] = [];
        for (const rc of parsed) {
          if (seen.has(rc.name.toLowerCase())) continue;
          added.push(
            createEmptyCandidate({
              name: rc.name,
              rationale: rc.rationale,
              style: rc.style,
            })
          );
          seen.add(rc.name.toLowerCase());
        }
        pushToast({
          kind: "success",
          message: `Added ${added.length} new candidate${added.length === 1 ? "" : "s"}`,
          ttlMs: 3500,
        });
        return { ...prev, candidates: [...prev.candidates, ...added] };
      });
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Name generation failed",
        detail: errDetail(err),
      });
    } finally {
      setAiGenNames(false);
    }
  };

  // ── Add / remove / choose candidate ─────────────────────────────────
  const addManualCandidate = () => {
    const name = newCandidateName.trim();
    if (!name) return;
    if (scan.candidates.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      pushToast({ kind: "warn", message: `"${name}" is already in the scan` });
      return;
    }
    updateScan((prev) => ({
      ...prev,
      candidates: [...prev.candidates, createEmptyCandidate({ name })],
    }));
    setNewCandidateName("");
  };

  const removeCandidate = (id: string) => {
    updateScan((prev) => ({
      ...prev,
      candidates: prev.candidates.filter((c) => c.id !== id),
      chosenCandidateId: prev.chosenCandidateId === id ? null : prev.chosenCandidateId,
    }));
  };

  const chooseCandidate = (id: string) => {
    updateScan((prev) => ({
      ...prev,
      chosenCandidateId: prev.chosenCandidateId === id ? null : id,
    }));
  };

  // ── Availability checks ─────────────────────────────────────────────

  /**
   * Run the full availability sweep on a single candidate: domains from
   * DEFAULT_DOMAIN_TLDS, all 6 socials, plus open the UK IPO trademark
   * search page. Staggered 400ms between platform hits to reduce the
   * chance of a shared-IP 429 from Meta properties. Results fill in per
   * slot as they resolve — the UI doesn't wait for the whole sweep.
   */
  const checkCandidate = async (candidate: NamingCandidate) => {
    if (checking[candidate.id]) return;
    setChecking((c) => ({ ...c, [candidate.id]: true }));

    const now = () => new Date().toISOString();
    const name = candidate.name.toLowerCase();
    const handle = slugify(candidate.name).replace(/-/g, "");

    // Kick off domain checks in parallel (they're independent and fast).
    const domainPromises = DEFAULT_DOMAIN_TLDS.map(async (tld) => {
      const domain = `${name}${tld}`;
      try {
        const result = await invoke<{ status: AvailabilityStatus; detail: string }>(
          "check_domain",
          { domain }
        );
        return [domain, { ...result, checkedAt: now() }] as const;
      } catch (err) {
        return [
          domain,
          {
            status: "error" as AvailabilityStatus,
            detail: errDetail(err),
            checkedAt: now(),
          },
        ] as const;
      }
    });

    // Socials — staggered to stay below rate limits.
    const socialPromises: Array<Promise<readonly [SocialPlatform, AvailabilityCheck]>> = [];
    SOCIAL_PLATFORMS.forEach((platform, i) => {
      socialPromises.push(
        new Promise((resolve) => {
          setTimeout(async () => {
            try {
              const result = await invoke<{
                status: AvailabilityStatus;
                detail: string;
              }>("check_social_handle", { platform, handle });
              resolve([platform, { ...result, checkedAt: now() }] as const);
            } catch (err) {
              resolve([
                platform,
                {
                  status: "error",
                  detail: errDetail(err),
                  checkedAt: now(),
                } as AvailabilityCheck,
              ] as const);
            }
          }, i * 400);
        })
      );
    });

    try {
      const [domains, socials] = await Promise.all([
        Promise.all(domainPromises),
        Promise.all(socialPromises),
      ]);
      updateScan((prev) => ({
        ...prev,
        candidates: prev.candidates.map((c) => {
          if (c.id !== candidate.id) return c;
          const domainStatus = { ...c.domainStatus };
          for (const [d, r] of domains) domainStatus[d] = r;
          const socialStatus = { ...c.socialStatus };
          for (const [p, r] of socials) socialStatus[p] = r;
          return {
            ...c,
            domainStatus,
            socialStatus,
            updatedAt: now(),
          };
        }),
      }));
      pushToast({
        kind: "success",
        message: `Checked ${candidate.name}`,
        detail: `${domains.length} domains · ${socials.length} socials`,
        ttlMs: 3500,
      });
    } catch (err) {
      pushToast({
        kind: "error",
        message: `Check failed for "${candidate.name}"`,
        detail: errDetail(err),
      });
    } finally {
      setChecking((c) => {
        const next = { ...c };
        delete next[candidate.id];
        return next;
      });
    }
  };

  const openTrademarkSearch = async (
    candidate: NamingCandidate,
    jurisdiction: TrademarkJurisdiction = "uk"
  ) => {
    const url = trademarkSearchUrl(candidate.name, jurisdiction);
    const officeLabel = TRADEMARK_JURISDICTION_LABELS[jurisdiction];
    try {
      await invoke("open_url", { url });
      // pt.31b: status keyed by jurisdiction so we can record each
      // office independently. User flips to taken/available manually
      // after reviewing — same flow as the original UK-only path.
      updateCandidate(candidate.id, {
        trademarkStatus: {
          ...candidate.trademarkStatus,
          [jurisdiction]: {
            status: "restricted",
            detail: `${officeLabel} search opened — flip status below after reviewing`,
            checkedAt: new Date().toISOString(),
          },
        },
      });
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Couldn't open trademark search",
        detail: errDetail(err),
      });
    }
  };

  const setTrademarkVerdict = (
    candidate: NamingCandidate,
    jurisdiction: TrademarkJurisdiction,
    status: AvailabilityStatus
  ) => {
    updateCandidate(candidate.id, {
      trademarkStatus: {
        ...candidate.trademarkStatus,
        [jurisdiction]: {
          status,
          detail: "Set manually",
          checkedAt: new Date().toISOString(),
        },
      },
    });
  };

  // ── Section: DIRECTION ──────────────────────────────────────────────
  const togglePersonality = (p: BrandPersonality) => {
    const has = canvas.personality.includes(p);
    if (has) {
      updateCanvas({ personality: canvas.personality.filter((x) => x !== p) });
    } else if (canvas.personality.length < 3) {
      updateCanvas({ personality: [...canvas.personality, p] });
    } else {
      pushToast({
        kind: "warn",
        message: "Max 3 personality traits",
        detail: "Remove one to add another.",
      });
    }
  };

  const applyPreset = (key: string) => {
    const preset = PRESET_PALETTES[key];
    if (!preset) return;
    updateCanvas({ palette: { ...preset.palette } });
    pushToast({
      kind: "info",
      message: `Applied "${preset.label}" palette`,
      ttlMs: 2500,
    });
  };

  // ── Section: LOGO — save brief + generate pack ──────────────────────

  /**
   * Serialise the canvas into a validated BrandBrief and write it. Any
   * schema failure surfaces via toast before we touch disk — the user
   * sees exactly which field is wrong. Mirrors pt.15's validation-on-write
   * philosophy.
   */
  const handleSaveBrief = async () => {
    if (savingBrief) return;
    if (!chosenName) {
      pushToast({
        kind: "warn",
        message: "Choose a name first",
        detail: "Add a candidate and mark it as chosen before saving the brief.",
      });
      return;
    }
    setSavingBrief(true);
    try {
      const now = new Date().toISOString();
      const raw = {
        ventureId: venture.id,
        ventureSlug: slugify(chosenName) || venture.slug,
        companyName: chosenName,
        tagline: canvas.tagline,
        mission: canvas.mission,
        targetAudience: canvas.targetAudience,
        personality: canvas.personality,
        toneOfVoice: canvas.toneOfVoice,
        competitors: canvas.competitors,
        differentiators: canvas.differentiators,
        colorPalette: canvas.palette,
        typography: canvas.typography,
        logoSpec: {
          style: "icon+wordmark" as const,
          tagline: canvas.tagline,
        },
        createdAt: now,
        version: 1,
      };
      const parsed = BrandBriefSchema.safeParse(raw);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const fieldPath = first ? first.path.join(".") : "unknown";
        const fieldMsg = first ? first.message : "unknown validation error";
        pushToast({
          kind: "error",
          message: "Brief didn't validate",
          detail: `${fieldPath}: ${fieldMsg}`,
        });
        return;
      }
      await invoke("mkdir_p", { path: getBrandKitDir(venture.rootPath) });
      await invoke("write_file", {
        path: briefPath(venture.rootPath),
        content: JSON.stringify(parsed.data, null, 2) + "\n",
      });
      pushToast({
        kind: "success",
        message: "Brand brief saved",
        detail: "03_brand/brand-kit/brand-brief.json",
        ttlMs: 3500,
      });
      refreshArtifacts(venture.rootPath);
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Couldn't save brand brief",
        detail: errDetail(err),
      });
    } finally {
      setSavingBrief(false);
    }
  };

  /** Generate the deterministic logo pack via materializeBrandPack. */
  const handleGenerateLogoPack = async () => {
    if (generatingLogo) return;
    setGeneratingLogo(true);
    try {
      // Read the brief from disk — it's the authoritative input. If it's
      // missing we error out rather than re-deriving from canvas; saving
      // the brief is the explicit intent signal.
      const rawBrief = await invoke<string>("read_file", {
        path: briefPath(venture.rootPath),
      }).catch(() => null);
      if (!rawBrief) {
        pushToast({
          kind: "warn",
          message: "Save the brief first",
          detail: "Logo generation reads from brand-brief.json.",
        });
        return;
      }
      const briefParsed = BrandBriefSchema.safeParse(JSON.parse(rawBrief));
      if (!briefParsed.success) {
        const first = briefParsed.error.issues[0];
        pushToast({
          kind: "error",
          message: "Brief on disk is invalid",
          detail: first ? first.path.join(".") + ": " + first.message : "unknown",
        });
        return;
      }
      const brief: BrandBrief = briefParsed.data;
      const pack = materializeBrandPack(brief);
      const exportsDir = getLogoExportsDir(venture.rootPath);
      await invoke("mkdir_p", { path: exportsDir });
      await Promise.all(
        Object.entries(pack).map(([filename, content]) =>
          invoke("write_file", {
            path: joinPath(exportsDir, filename),
            content,
          })
        )
      );
      pushToast({
        kind: "success",
        message: "Logo pack generated",
        detail: `${Object.keys(pack).length} files under 03_brand/logo/exports/`,
        ttlMs: 3500,
      });
      refreshArtifacts(venture.rootPath);
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Couldn't generate logo pack",
        detail: errDetail(err),
      });
    } finally {
      setGeneratingLogo(false);
    }
  };

  /**
   * Generate 4 AI concept briefs. Streams each call independently and
   * collects the final text per concept. We call streamChat 4× in
   * parallel — the Rust side already has a concurrency cap per-provider
   * via the cancel registry, and 4 simultaneous completions is well
   * inside every provider's default limits.
   *
   * Existing concept files are skipped so the user can iterate on one
   * without clobbering the others — matches the pipeline step behaviour.
   */
  const handleGenerateConcepts = async () => {
    if (generatingConcepts) return;
    if (!hasBrief) {
      pushToast({
        kind: "warn",
        message: "Save the brief first",
        detail: "Concepts need a brief for context.",
      });
      return;
    }
    setGeneratingConcepts(true);
    try {
      const providerId = await pickActiveProvider(venture.id);
      if (!providerId) {
        pushToast({
          kind: "warn",
          message: "No AI provider configured",
          detail: "Open Options to add an API key.",
        });
        return;
      }
      const rawBrief = await invoke<string>("read_file", {
        path: briefPath(venture.rootPath),
      });
      const brief = BrandBriefSchema.parse(JSON.parse(rawBrief));
      const conceptsDir = getLogoConceptsDir(venture.rootPath);
      await invoke("mkdir_p", { path: conceptsDir });

      // pt.31a: SPECS + system prompt hoisted to module level so
      // handleRegenerateConcept can reuse them without duplication.
      const SPECS = CONCEPT_SPECS;
      const system = buildConceptSystemPrompt(brief, manifest?.appType);

      // Optimise the shared concept system prompt once, then fan out to
      // each spec. The closure inside Promise.allSettled re-uses the
      // result so we don't burn N parallel optimizer round-trips on the
      // same input.
      const optimizedSystem = await optimize({
        prompt: system,
        context: "wireframe",
        ventureId: venture.id,
      });
      console.info(
        "[prompt-master] brand-concepts",
        optimizedSystem.fallbackUsed
          ? "(fallback — transport unavailable)"
          : `tokensSaved=${optimizedSystem.tokensSaved} cacheHit=${optimizedSystem.cacheHit}`
      );

      const results = await Promise.allSettled(
        SPECS.map(async (spec) => {
          const outPath = joinPath(conceptsDir, spec.filename);
          const exists = await invoke<boolean>("path_exists", { path: outPath });
          if (exists) {
            return { spec, status: "skipped" as const };
          }
          let text = "";
          await streamChat({
            provider: providerId,
            messages: [
              {
                role: "user",
                content: `Write **${spec.title}** for ${brief.companyName}.\n\nDirection: ${spec.direction}\n\nWrite the full brief now.`,
              },
            ],
            system: optimizedSystem.optimized,
            maxTokens: 1600,
            temperature: 0.7,
            onDelta: (d) => {
              text += d;
            },
          });
          const cleaned = text.trim().startsWith("#")
            ? text.trim()
            : `# ${spec.title}\n\n${text.trim()}`;
          await invoke("write_file", {
            path: outPath,
            content: cleaned + "\n",
          });
          return { spec, status: "written" as const };
        })
      );

      const written = results.filter(
        (r) => r.status === "fulfilled" && r.value.status === "written"
      ).length;
      const skipped = results.filter(
        (r) => r.status === "fulfilled" && r.value.status === "skipped"
      ).length;
      const failed = results.filter((r) => r.status === "rejected").length;

      if (written > 0) {
        pushToast({
          kind: "success",
          message: `Generated ${written} concept${written === 1 ? "" : "s"}`,
          detail:
            skipped > 0
              ? `${skipped} skipped (delete to regenerate)`
              : failed > 0
                ? `${failed} failed — check the log`
                : undefined,
          ttlMs: 4500,
        });
      } else if (skipped > 0 && failed === 0) {
        pushToast({
          kind: "info",
          message: "All concepts already exist",
          detail: "Delete a file to regenerate.",
          ttlMs: 3500,
        });
      } else {
        pushToast({
          kind: "error",
          message: "Couldn't generate concepts",
          detail: `${failed} of ${SPECS.length} failed`,
        });
      }
      refreshArtifacts(venture.rootPath);
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Concept generation failed",
        detail: errDetail(err),
      });
    } finally {
      setGeneratingConcepts(false);
    }
  };

  /**
   * pt.31a: regenerate a SINGLE concept brief, overwriting the on-disk
   * file. Resolves the spec from the filename (concepts list keys off
   * the filename), reuses the same prompt builder + writer logic as the
   * bulk handler. Per-filename optimistic flag (`regeneratingConcept`)
   * gates the button so the user can't fire a second regen for the
   * same tile while one is in flight.
   *
   * Skip-if-exists is bypassed by design — that's the point of this
   * affordance. `write_file` overwrites unconditionally.
   */
  const handleRegenerateConcept = async (filename: string) => {
    if (!venture || generatingConcepts || regeneratingConcept) return;
    const spec = CONCEPT_SPECS.find((s) => s.filename === filename);
    if (!spec) {
      // Defensive — concepts list comes from on-disk scan; a file that
      // doesn't match any spec (e.g. an old concept-05) shouldn't be
      // regenerable through this affordance.
      pushToast({
        kind: "warn",
        message: `No spec for ${filename}`,
        detail: "Only concepts 01-04 can be regenerated.",
        ttlMs: 4000,
      });
      return;
    }
    if (!hasBrief) {
      pushToast({
        kind: "warn",
        message: "Save the brief first",
        detail: "Concept regeneration uses the saved brief for context.",
      });
      return;
    }
    // pt.32b: fresh AbortController per regen via the hook. Signal
    // flows into streamChat so the user can cancel mid-stream by
    // clicking ✕ on the same tile.
    const controller = regenTask.begin();
    setRegeneratingConcept(filename);
    try {
      const providerId = await pickActiveProvider(venture.id);
      if (!providerId) {
        pushToast({
          kind: "warn",
          message: "No AI provider configured",
          detail: "Open Options to add an API key.",
        });
        return;
      }
      const rawBrief = await invoke<string>("read_file", {
        path: briefPath(venture.rootPath),
      });
      const brief = BrandBriefSchema.parse(JSON.parse(rawBrief));
      const conceptsDir = getLogoConceptsDir(venture.rootPath);
      await invoke("mkdir_p", { path: conceptsDir });
      const system = buildConceptSystemPrompt(brief, manifest?.appType);
      const optimizedSystem = await optimize({
        prompt: system,
        context: "wireframe",
        ventureId: venture.id,
      });
      console.info(
        "[prompt-master] brand-concept-regen",
        optimizedSystem.fallbackUsed
          ? "(fallback — transport unavailable)"
          : `tokensSaved=${optimizedSystem.tokensSaved} cacheHit=${optimizedSystem.cacheHit}`
      );
      const outPath = joinPath(conceptsDir, spec.filename);
      let text = "";
      await streamChat({
        provider: providerId,
        messages: [
          {
            role: "user",
            content: `Write **${spec.title}** for ${brief.companyName}.\n\nDirection: ${spec.direction}\n\nWrite the full brief now.`,
          },
        ],
        system: optimizedSystem.optimized,
        maxTokens: 1600,
        temperature: 0.7,
        signal: controller.signal,
        onDelta: (d) => {
          text += d;
        },
      });
      const cleaned = text.trim().startsWith("#")
        ? text.trim()
        : `# ${spec.title}\n\n${text.trim()}`;
      await invoke("write_file", {
        path: outPath,
        content: cleaned + "\n",
      });
      pushToast({
        kind: "success",
        message: `Regenerated ${spec.title}`,
        ttlMs: 3500,
      });
      refreshArtifacts(venture.rootPath);
    } catch (err) {
      // pt.32b: discriminate cancel vs failure. AbortError from
      // streamChat is a benign user action — info toast, not error.
      // Any partial text we accumulated in `text` is discarded; the
      // on-disk file is untouched (write_file never ran).
      if (regenTask.wasCancelled(controller, err)) {
        pushToast({
          kind: "info",
          message: `Cancelled — ${spec.title} unchanged`,
          ttlMs: 3500,
        });
      } else {
        pushToast({
          kind: "error",
          message: "Regenerate failed",
          detail: errDetail(err),
        });
      }
    } finally {
      setRegeneratingConcept(null);
      regenTask.clear();
    }
  };

  const openFolder = async (path: string) => {
    try {
      await invoke("open_path", { path });
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Couldn't open folder",
        detail: errDetail(err),
      });
    }
  };

  // ── Strict gate computation ─────────────────────────────────────────
  const checks = useMemo(() => {
    const paletteValid = (
      ["primary", "secondary", "accent", "background", "surface", "text", "textMuted"] as const
    ).every((k) => isValidHex(canvas.palette[k]));
    return {
      nameChosen: chosenName.trim().length > 0,
      paletteValid,
      personalityPicked: canvas.personality.length >= 1,
      copyFilled:
        canvas.tagline.trim().length >= 20 &&
        canvas.mission.trim().length >= 20 &&
        canvas.targetAudience.trim().length >= 20,
      briefOnDisk: hasBrief,
      logoPackOnDisk: hasLogo && hasTokens,
    };
  }, [canvas, chosenName, hasBrief, hasLogo, hasTokens]);

  const checkCount = Object.values(checks).filter(Boolean).length;
  const allChecks = checkCount === 6;

  // ── AI logo + full-pack handlers ───────────────────────────────────
  //
  // These three buttons (Generate candidates, Lock brand, Generate pack)
  // all ultimately call streamChat with a provider chosen by the user
  // via ProviderPickerDialog. We keep each click handler thin — it sets
  // pickerIntent + opens the dialog — and the real work happens in
  // `handlePickerConfirm` which dispatches on intent. This avoids
  // duplicating the "open picker, wait for choice, then run" pattern
  // across three buttons.

  /** Compose the minimal brief slice the AI generators need. The full
   *  BrandBrief has 20+ fields; generators only consume 10-ish. */
  const composeBrief = (): BrandGenBrief => ({
    companyName: chosenName || "Untitled brand",
    tagline: canvas.tagline.trim() || undefined,
    mission: canvas.mission.trim() || undefined,
    targetAudience: canvas.targetAudience.trim() || undefined,
    personality: canvas.personality,
    toneOfVoice: canvas.toneOfVoice.trim() || undefined,
    palette: canvas.palette,
    typography: {
      headingFont: canvas.typography.headingFont,
      bodyFont: canvas.typography.bodyFont,
    },
  });

  const handleGenerateCandidatesClick = () => {
    setCandidateError(null);
    if (!chosenName) {
      setCandidateError(
        "Choose a name candidate first — generators use the chosen name as the brand name."
      );
      return;
    }
    setPickerIntent("logo-candidates");
    setPickerOpen(true);
  };

  const handleGeneratePackClick = () => {
    setPackError(null);
    if (!brandLocked) {
      setPackError("Lock your logo + palette first.");
      return;
    }
    setPickerIntent("full-pack");
    setPickerOpen(true);
  };

  const runLogoCandidates = async (providerId: LlmProviderId) => {
    setGeneratingCandidates(true);
    setCandidateError(null);
    setLogoCandidates([]);
    try {
      const brief = composeBrief();
      // Stream candidates as they complete so the grid fills in
      // progressively — users don't wait for all 4 to finish before
      // seeing anything.
      await generateLogoCandidates({
        brief,
        provider: providerId,
        ventureId: venture.id,
        onArchetypeDone: (candidate) => {
          setLogoCandidates((prev) => {
            // Stable slot order: replace-or-append by archetype id.
            const idx = prev.findIndex((c) => c.archetype === candidate.archetype);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = candidate;
              return next;
            }
            return [...prev, candidate];
          });
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCandidateError(`Logo generation failed: ${msg}`);
    } finally {
      setGeneratingCandidates(false);
    }
  };

  /** User picked one of the 4 AI candidates. Stash the SVG, extract
   *  unique fill/stroke colours, and splice them into the palette so
   *  the Direction section's ColorPalette editor shows a matched set.
   *  Only overwrite the primary/secondary/accent slots — we leave
   *  background/surface/text alone since those are functional, not
   *  brand-identity colours. */
  const handleUseCandidate = (candidate: LogoCandidate) => {
    if (!candidate.svg) return;
    setChosenLogoSvg(candidate.svg);
    setChosenLogoArchetype(candidate.archetype);
    setBrandLocked(false); // picking a new logo re-opens the lock gate

    const extracted = extractPaletteFromSvg(candidate.svg);
    if (extracted.length > 0) {
      setCanvas((prev) => ({
        ...prev,
        palette: {
          ...prev.palette,
          primary: extracted[0] ?? prev.palette.primary,
          secondary: extracted[1] ?? prev.palette.secondary,
          accent: extracted[2] ?? prev.palette.accent,
        },
        updatedAt: new Date().toISOString(),
      }));
    }

    // Also write the chosen logo SVG to the canonical location so
    // downstream steps (pack generator, ZIP export) can read it back.
    // joinPath is a two-arg helper, so we build the path by chaining
    // four joins rather than reaching for a variadic "path.join".
    const generatedDir = joinPath(
      joinPath(joinPath(venture.rootPath, "03_brand"), "logo"),
      "generated"
    );
    const chosenLogoPath = joinPath(generatedDir, "logo-chosen.svg");
    invoke("mkdir_p", { path: generatedDir })
      .then(() =>
        invoke("write_file", {
          path: chosenLogoPath,
          content: candidate.svg,
        })
      )
      .catch((err) => {
        console.warn("[brand] persist chosen logo failed", err);
      });

    pushToast({
      kind: "success",
      message: `Using ${candidate.archetype} as the brand logo`,
      detail:
        extracted.length > 0
          ? `Palette seeded with ${extracted.length} colour(s) from the logo.`
          : undefined,
    });
  };

  const handleLockBrand = () => {
    if (!chosenLogoSvg) {
      setCandidateError("Pick a logo first.");
      return;
    }
    setBrandLocked(true);
    pushToast({
      kind: "success",
      message: "Brand locked",
      detail: "Logo + palette committed. Ready to generate the full pack.",
    });
  };

  const runFullPack = async (providerId: LlmProviderId) => {
    setGeneratingPack(true);
    setPackError(null);
    setPackZipPath(null);
    // Seed the progress list so all 6 cards render immediately in idle
    // state and flip to running/done/error as generators settle.
    setPackEntries(FULL_PACK_SPECS.map((spec) => ({ spec, status: "idle" })));
    try {
      const brief = composeBrief();
      const results = await generateFullPack({
        brief,
        provider: providerId,
        lockedLogoSvg: chosenLogoSvg,
        ventureId: venture.id,
        onAssetStart: (spec) => {
          setPackEntries((prev) =>
            prev.map((e) => (e.spec.key === spec.key ? { ...e, status: "running" } : e))
          );
        },
        onAssetDone: (r: PackAssetResult) => {
          setPackEntries((prev) =>
            prev.map((e) =>
              e.spec.key === r.spec.key
                ? {
                    ...e,
                    status: r.error ? "error" : "done",
                    content: r.content,
                    error: r.error,
                  }
                : e
            )
          );
        },
      });

      // Persist every successful asset to disk. We write even if some
      // errored so the user doesn't lose the ones that worked.
      // joinPath is binary so we nest it for deeper paths.
      const exportsDir = joinPath(joinPath(venture.rootPath, "03_brand"), "exports");
      await invoke("mkdir_p", { path: exportsDir });
      for (const r of results) {
        if (r.error || !r.content) continue;
        // r.spec.relPath already contains forward-slash subpath
        // (e.g. "social/linkedin-banner.svg"). Split into dir + file,
        // normalize separators for Windows, recreate the directory
        // under exportsDir, then write the file.
        const parts = r.spec.relPath.split("/").filter(Boolean);
        let dirForWrite = exportsDir;
        for (let i = 0; i < parts.length - 1; i++) {
          dirForWrite = joinPath(dirForWrite, parts[i]);
        }
        const filePath = joinPath(dirForWrite, parts[parts.length - 1]);
        try {
          await invoke("mkdir_p", { path: dirForWrite });
          await invoke("write_file", { path: filePath, content: r.content });
        } catch (err) {
          console.warn("[brand] failed to persist asset", r.spec.key, err);
        }
      }

      // Also persist the locked logo as the canonical pack logo.
      try {
        const logoDir = joinPath(exportsDir, "logo");
        await invoke("mkdir_p", { path: logoDir });
        await invoke("write_file", {
          path: joinPath(logoDir, "logo.svg"),
          content: chosenLogoSvg,
        });
      } catch (err) {
        console.warn("[brand] failed to persist locked logo", err);
      }

      const failed = results.filter((r) => r.error).length;
      if (failed === 0) {
        pushToast({
          kind: "success",
          message: "Brand pack generated",
          detail: `All ${results.length} assets ready under 03_brand/exports/.`,
        });
      } else {
        setPackError(`${failed} of ${results.length} assets failed. Hit Retry on the red cards.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPackError(`Pack generation failed: ${msg}`);
    } finally {
      setGeneratingPack(false);
    }
  };

  const handlePickerConfirm = async (providerId: LlmProviderId) => {
    const intent = pickerIntent;
    setPickerOpen(false);
    setPickerIntent(null);
    if (intent === "logo-candidates") {
      await runLogoCandidates(providerId);
    } else if (intent === "full-pack") {
      await runFullPack(providerId);
    }
  };

  const handleDownloadPack = async () => {
    try {
      const zipPath = await invoke<string>("brand_zip_pack", {
        venturePath: venture.rootPath,
      });
      setPackZipPath(zipPath);
      pushToast({
        kind: "success",
        message: "Brand pack ZIP ready",
        detail: zipPath,
      });
      // Reveal in the OS file manager so the user can drag it out.
      invoke("open_path", { path: zipPath }).catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPackError(`ZIP export failed: ${msg}`);
    }
  };

  const handleAdvance = async () => {
    if (!allChecks || advancing) return;
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

  // ── Render ──────────────────────────────────────────────────────────
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
            Brand Workshop
          </h3>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6B7280" }}>
            Name → direction → logo → pack. Save as you go; everything lands under{" "}
            <code>03_brand/</code>.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <SaveIndicator status={saveStatus} />
          <button
            type="button"
            onClick={handleAdvance}
            disabled={!allChecks || advancing}
            title={
              allChecks
                ? "All 6 must-haves complete — advance"
                : `${checkCount}/6 complete — finish the checklist`
            }
            style={{
              padding: "8px 16px",
              background: allChecks ? "#6366F1" : "#E5E7EB",
              color: allChecks ? "#FFFFFF" : "#9CA3AF",
              border: "none",
              borderRadius: 6,
              fontWeight: 700,
              fontSize: 13,
              cursor: allChecks ? "pointer" : "not-allowed",
              whiteSpace: "nowrap",
            }}
          >
            {advancing ? "Advancing…" : "Advance to UK Setup →"}
          </button>
        </div>
      </div>

      {/* Two-column layout */}
      <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
        {/* LEFT — main workflow */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 20 }}>
          {/* 1 — Name */}
          <Section
            title="1. Name & Availability"
            icon="🏷️"
            open={openSections.name}
            onToggle={() => setOpenSections((s) => ({ ...s, name: !s.name }))}
          >
            <p style={{ margin: 0, fontSize: 12, color: "#6B7280" }}>
              Generate candidates, check domains / trademarks / socials, pick a winner. Saved to{" "}
              <code>03_brand/names/name-candidates.json</code>.
            </p>

            {/* AI generate */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                padding: 12,
                background: "#F9FAFB",
                borderRadius: 8,
              }}
            >
              <Field
                label="Hints for the AI (optional)"
                hint="Values, keywords, names to avoid, industry slang, etc."
              >
                <Textarea
                  value={aiSeedHints}
                  onChange={setAiSeedHints}
                  placeholder="e.g. we like short invented names, avoid anything ending in -ly, must hint at speed"
                  rows={2}
                />
              </Field>
              <button
                type="button"
                onClick={handleAiGenerateNames}
                disabled={aiGenNames}
                style={{
                  alignSelf: "flex-start",
                  padding: "8px 14px",
                  background: aiGenNames ? "#F3F4F6" : "#EEF2FF",
                  border: `1px solid ${aiGenNames ? "#E5E7EB" : "#C7D2FE"}`,
                  borderRadius: 6,
                  fontSize: 13,
                  color: aiGenNames ? "#9CA3AF" : "#4F46E5",
                  cursor: aiGenNames ? "not-allowed" : "pointer",
                  fontWeight: 600,
                }}
              >
                {aiGenNames ? "⏳ Generating…" : "🤖 AI generate 8 candidates"}
              </button>
            </div>

            {/* Manual add */}
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                value={newCandidateName}
                onChange={(e) => setNewCandidateName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addManualCandidate();
                }}
                placeholder="Add a name manually…"
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                type="button"
                onClick={addManualCandidate}
                disabled={!newCandidateName.trim()}
                style={{
                  padding: "7px 14px",
                  background: newCandidateName.trim() ? "#111827" : "#E5E7EB",
                  color: newCandidateName.trim() ? "#FFFFFF" : "#9CA3AF",
                  border: "none",
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: newCandidateName.trim() ? "pointer" : "not-allowed",
                }}
              >
                Add
              </button>
            </div>

            {/* Candidates */}
            {scan.candidates.length === 0 ? (
              <div
                style={{
                  padding: 20,
                  background: "#F9FAFB",
                  border: "1px dashed #E5E7EB",
                  borderRadius: 8,
                  textAlign: "center",
                  fontSize: 13,
                  color: "#9CA3AF",
                }}
              >
                No candidates yet. Generate some or add one manually above.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {scan.candidates.map((c) => (
                  <CandidateCard
                    key={c.id}
                    candidate={c}
                    chosen={scan.chosenCandidateId === c.id}
                    checking={!!checking[c.id]}
                    onChoose={() => chooseCandidate(c.id)}
                    onRemove={() => removeCandidate(c.id)}
                    onCheck={() => checkCandidate(c)}
                    onOpenTrademark={(j) => openTrademarkSearch(c, j)}
                    onSetTrademark={(j, s) => setTrademarkVerdict(c, j, s)}
                    onUpdateNotes={(notes) => updateCandidate(c.id, { notes })}
                  />
                ))}
              </div>
            )}
          </Section>

          {/* 2 — Direction */}
          <Section
            title="2. Brand Direction"
            icon="🎨"
            open={openSections.direction}
            onToggle={() => setOpenSections((s) => ({ ...s, direction: !s.direction }))}
          >
            <p style={{ margin: 0, fontSize: 12, color: "#6B7280" }}>
              Personality, palette, typography, voice. This powers the brand brief and downstream
              logo / site generation.
            </p>

            <Field
              label="Tagline"
              required
              hint="8-14 words. What you do, for whom, how you're different."
            >
              <Textarea
                value={canvas.tagline}
                onChange={(v) => updateCanvas({ tagline: v })}
                placeholder="e.g. InvoiceChaser helps UK freelancers get paid on time, automatically."
                rows={2}
              />
              <CharCount value={canvas.tagline} min={20} />
            </Field>
            <Field
              label="Mission"
              required
              hint="One sentence. The change you're trying to make in the world."
            >
              <Textarea
                value={canvas.mission}
                onChange={(v) => updateCanvas({ mission: v })}
                placeholder="e.g. Eliminate the £30B+ lost annually to late payments in the UK freelance economy."
                rows={2}
              />
              <CharCount value={canvas.mission} min={20} />
            </Field>
            <Field label="Target audience" required hint="Specific. Job title, situation, context.">
              <Textarea
                value={canvas.targetAudience}
                onChange={(v) => updateCanvas({ targetAudience: v })}
                placeholder="e.g. UK-based freelance developers and designers, solo, 3-10 active clients, billing £30k-£150k/year."
                rows={2}
              />
              <CharCount value={canvas.targetAudience} min={20} />
            </Field>

            {/* Personality */}
            <Field label="Personality (pick 1-3)" required hint="How the brand *feels*.">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {PERSONALITIES.map((p) => {
                  const active = canvas.personality.includes(p);
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => togglePersonality(p)}
                      style={{
                        padding: "6px 12px",
                        background: active ? "#6366F1" : "#FFFFFF",
                        color: active ? "#FFFFFF" : "#374151",
                        border: `1px solid ${active ? "#6366F1" : "#D1D5DB"}`,
                        borderRadius: 999,
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: "pointer",
                        textTransform: "capitalize",
                      }}
                    >
                      {p}
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label="Tone of voice" hint="Describe + optional examples of on/off-brand copy.">
              <Textarea
                value={canvas.toneOfVoice}
                onChange={(v) => updateCanvas({ toneOfVoice: v })}
                placeholder="e.g. Warm, direct, occasionally cheeky. On-brand: 'We'll chase them, you chase the work.' Off-brand: 'Leveraging synergies.'"
                rows={3}
              />
            </Field>

            {/* Palette */}
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 8,
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>Palette</span>
                <div style={{ display: "flex", gap: 6 }}>
                  {Object.entries(PRESET_PALETTES).map(([key, p]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => applyPreset(key)}
                      title={`Apply "${p.label}" preset`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "5px 10px",
                        background: "#FFFFFF",
                        border: "1px solid #D1D5DB",
                        borderRadius: 6,
                        fontSize: 11,
                        color: "#374151",
                        cursor: "pointer",
                        fontWeight: 600,
                      }}
                    >
                      <span
                        style={{
                          display: "inline-block",
                          width: 10,
                          height: 10,
                          borderRadius: 2,
                          background: p.palette.primary,
                          border: "1px solid rgba(0,0,0,0.1)",
                        }}
                      />
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <PaletteEditor palette={canvas.palette} onChange={updatePalette} />
            </div>

            {/* Typography */}
            <div style={{ display: "flex", gap: 12 }}>
              <Field label="Heading font" style={{ flex: 1 }}>
                <input
                  type="text"
                  list="brandtab-font-suggestions"
                  value={canvas.typography.headingFont}
                  onChange={(e) => updateTypography({ headingFont: e.target.value })}
                  style={inputStyle}
                />
              </Field>
              <Field label="Body font" style={{ flex: 1 }}>
                <input
                  type="text"
                  list="brandtab-font-suggestions"
                  value={canvas.typography.bodyFont}
                  onChange={(e) => updateTypography({ bodyFont: e.target.value })}
                  style={inputStyle}
                />
              </Field>
            </div>
            <datalist id="brandtab-font-suggestions">
              {FONT_SUGGESTIONS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
            <TypographyPreview
              palette={canvas.palette}
              typography={canvas.typography}
              sample={chosenName || venture.name}
            />
          </Section>

          {/* 3 — Logo */}
          <Section
            title="3. Logo Pack & Concepts"
            icon="🖼️"
            open={openSections.logo}
            onToggle={() => setOpenSections((s) => ({ ...s, logo: !s.logo }))}
          >
            <p style={{ margin: 0, fontSize: 12, color: "#6B7280" }}>
              Save the brief first, then generate deterministic SVGs + 4 AI concept briefs.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button
                type="button"
                onClick={handleSaveBrief}
                disabled={savingBrief}
                style={primaryButton(savingBrief)}
              >
                {savingBrief ? "Saving…" : hasBrief ? "Update brief" : "Save brief"}
              </button>
              <button
                type="button"
                onClick={handleGenerateLogoPack}
                disabled={generatingLogo || !hasBrief}
                title={!hasBrief ? "Save the brief first" : "Generate SVGs + tokens"}
                style={primaryButton(generatingLogo || !hasBrief, "#059669")}
              >
                {generatingLogo
                  ? "Generating…"
                  : hasLogo
                    ? "Regenerate logo pack"
                    : "Generate logo pack"}
              </button>
              <button
                type="button"
                onClick={handleGenerateConcepts}
                disabled={generatingConcepts || !hasBrief}
                title={!hasBrief ? "Save the brief first" : "4 AI-written concept briefs"}
                style={primaryButton(generatingConcepts || !hasBrief, "#8B5CF6")}
              >
                {generatingConcepts ? "Generating…" : "✨ Generate 4 concept briefs"}
              </button>
            </div>

            {/* Concepts list */}
            {concepts.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
                  Concept briefs ({concepts.length})
                </span>
                {concepts.map((name) => {
                  // pt.31a: per-tile regen state. Only the targeted
                  // tile shows "Regenerating…"; the others stay enabled
                  // visually but the cross-handler guard inside
                  // handleRegenerateConcept blocks parallel fires.
                  const isThisRegenerating = regeneratingConcept === name;
                  const otherInFlight =
                    (regeneratingConcept !== null && !isThisRegenerating) || generatingConcepts;
                  // Only canonical concepts (01-04) match a spec — old
                  // or hand-named files in the dir won't have a regen
                  // affordance.
                  const hasSpec = CONCEPT_SPECS.some((s) => s.filename === name);
                  return (
                    <div
                      key={name}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "7px 12px",
                        background: "#FFFFFF",
                        border: "1px solid #E5E7EB",
                        borderRadius: 6,
                        fontSize: 13,
                      }}
                    >
                      <span style={{ fontSize: 14 }}>📄</span>
                      <span style={{ flex: 1, color: "#111827" }}>{name}</span>
                      {hasSpec && (
                        <button
                          type="button"
                          // pt.32b: dual-purpose button — when this tile
                          // is regenerating, click cancels (✕). When
                          // idle, click triggers regen (↻). The
                          // `disabled` gate on `otherInFlight` only
                          // applies to idle tiles; the active tile is
                          // always clickable so the user can cancel.
                          onClick={() => {
                            if (isThisRegenerating) {
                              regenTask.cancel();
                            } else {
                              handleRegenerateConcept(name);
                            }
                          }}
                          disabled={otherInFlight && !isThisRegenerating}
                          style={{
                            ...iconButtonStyle,
                            color: isThisRegenerating ? "#DC2626" : "#6B7280",
                            cursor:
                              otherInFlight && !isThisRegenerating ? "not-allowed" : "pointer",
                            opacity: otherInFlight && !isThisRegenerating ? 0.4 : 1,
                            fontSize: 12,
                            fontWeight: 600,
                            padding: "2px 8px",
                          }}
                          title={
                            isThisRegenerating
                              ? "Cancel regeneration"
                              : otherInFlight
                                ? "Another concept is regenerating"
                                : "Regenerate this concept (overwrites the file)"
                          }
                        >
                          {isThisRegenerating ? "✕" : "↻"}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          invoke("open_path", {
                            path: joinPath(getLogoConceptsDir(venture.rootPath), name),
                          }).catch(() => {})
                        }
                        style={iconButtonStyle}
                        title="Reveal in file manager"
                      >
                        ↗
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Logo preview */}
            {hasLogo && <LogoPreview rootPath={venture.rootPath} />}
          </Section>

          {/*
             AI logo candidates — the new subscription-CLI-driven flow.
             Unlike section 3's deterministic wordmark (built from the
             palette mechanically) and concept briefs (markdown-only),
             this produces 4 actual SVG logo designs the user can pick
             from. Provider picker lets them choose Claude / ChatGPT /
             Gemini per generation.
          */}
          <Section
            title="AI Logo Candidates"
            icon="🎨"
            open={openSections.aiCandidates}
            onToggle={() =>
              setOpenSections((s) => ({
                ...s,
                aiCandidates: !s.aiCandidates,
              }))
            }
          >
            <p style={{ margin: 0, fontSize: 12, color: "#6B7280" }}>
              Four SVG logo archetypes generated in parallel. Pick one to seed the palette and
              unlock the full brand pack.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button
                type="button"
                onClick={handleGenerateCandidatesClick}
                disabled={generatingCandidates || !chosenName}
                title={!chosenName ? "Pick a name candidate first" : "Generate 4 logo candidates"}
                style={primaryButton(generatingCandidates || !chosenName, "#6366F1")}
              >
                {generatingCandidates
                  ? "Generating candidates…"
                  : logoCandidates.length > 0
                    ? "Regenerate candidates"
                    : "✨ Generate 4 logo candidates"}
              </button>
              {chosenLogoSvg && !brandLocked && (
                <button
                  type="button"
                  onClick={handleLockBrand}
                  style={primaryButton(false, "#047857")}
                >
                  🔒 Lock logo + palette
                </button>
              )}
              {brandLocked && (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "6px 10px",
                    background: "#ECFDF5",
                    color: "#047857",
                    border: "1px solid #A7F3D0",
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  🔒 Brand locked — ready for full pack
                </span>
              )}
            </div>
            {candidateError && (
              <div
                role="alert"
                style={{
                  padding: "8px 10px",
                  background: "#FEF2F2",
                  color: "#991B1B",
                  border: "1px solid #FECACA",
                  borderRadius: 6,
                  fontSize: 12,
                }}
              >
                {candidateError}
              </div>
            )}
            {(generatingCandidates || logoCandidates.length > 0) && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 12,
                  marginTop: 8,
                }}
              >
                {(logoCandidates.length > 0
                  ? logoCandidates
                  : // Placeholder slots so the grid layout appears
                    // immediately; cards transition as SVGs land.
                    (
                      [
                        "wordmark",
                        "lettermark",
                        "icon-wordmark",
                        "abstract-mark",
                      ] as LogoArchetype[]
                    ).map((a) => ({
                      archetype: a,
                      svg: "",
                      description: "",
                      provider: "anthropic" as LlmProviderId,
                    }))
                ).map((candidate) => (
                  <LogoCandidateCard
                    key={candidate.archetype}
                    candidate={candidate as LogoCandidate & { error?: string }}
                    isChosen={chosenLogoArchetype === candidate.archetype}
                    isGenerating={generatingCandidates && !candidate.svg}
                    onUse={() => handleUseCandidate(candidate as LogoCandidate)}
                  />
                ))}
              </div>
            )}
          </Section>

          {/*
             Full brand pack generation — gated by brandLocked. Fires a
             parallel generator per asset (email header, social banners,
             brand guide MD) using the locked logo + palette. Progress
             list updates live; assets land in 03_brand/exports/ and
             can be zipped for download.
          */}
          <Section
            title="Full Brand Pack"
            icon="📦"
            open={openSections.fullPack}
            onToggle={() => setOpenSections((s) => ({ ...s, fullPack: !s.fullPack }))}
          >
            <p style={{ margin: 0, fontSize: 12, color: "#6B7280" }}>
              Email header, social banners (X, LinkedIn, OG), email signature template, brand guide
              MD — generated in parallel off your locked logo and palette.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button
                type="button"
                onClick={handleGeneratePackClick}
                disabled={generatingPack || !brandLocked}
                title={!brandLocked ? "Lock a logo first" : "Generate the full brand pack"}
                style={primaryButton(generatingPack || !brandLocked, "#0EA5E9")}
              >
                {generatingPack
                  ? "Generating pack…"
                  : packEntries.some((e) => e.status === "done")
                    ? "Regenerate full pack"
                    : "✨ Generate full brand pack"}
              </button>
              {packEntries.some((e) => e.status === "done") && (
                <button
                  type="button"
                  onClick={handleDownloadPack}
                  style={primaryButton(false, "#7C3AED")}
                  title="Zip 03_brand/exports/ into brand-pack.zip"
                >
                  📥 Download brand-pack.zip
                </button>
              )}
            </div>
            {packError && (
              <div
                role="alert"
                style={{
                  padding: "8px 10px",
                  background: "#FEF2F2",
                  color: "#991B1B",
                  border: "1px solid #FECACA",
                  borderRadius: 6,
                  fontSize: 12,
                }}
              >
                {packError}
              </div>
            )}
            {packZipPath && (
              <div
                style={{
                  padding: "8px 10px",
                  background: "#ECFDF5",
                  color: "#047857",
                  border: "1px solid #A7F3D0",
                  borderRadius: 6,
                  fontSize: 12,
                }}
              >
                ZIP saved: <code>{packZipPath}</code>
              </div>
            )}
            {packEntries.length > 0 && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  marginTop: 8,
                }}
              >
                {packEntries.map((entry) => (
                  <PackAssetRow key={entry.spec.key} entry={entry} />
                ))}
              </div>
            )}
          </Section>

          {/* 4 — Brand Pack summary */}
          <Section
            title="4. Brand Pack Summary"
            icon="📦"
            open={openSections.pack}
            onToggle={() => setOpenSections((s) => ({ ...s, pack: !s.pack }))}
          >
            <PackSummary
              rootPath={venture.rootPath}
              hasBrief={hasBrief}
              hasLogo={hasLogo}
              hasTokens={hasTokens}
              conceptCount={concepts.length}
              onOpenFolder={() => openFolder(getStagePath(venture.rootPath, "brand"))}
            />
          </Section>
        </div>

        {/* RIGHT — checklist */}
        <div style={{ width: 300, flexShrink: 0, position: "sticky", top: 0 }}>
          <div
            style={{
              background: "#FFFFFF",
              border: "1px solid #E5E7EB",
              borderRadius: 10,
              padding: 16,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 12,
              }}
            >
              <h4 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#111827" }}>
                Must-haves
              </h4>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: allChecks ? "#059669" : "#6366F1",
                }}
              >
                {checkCount} / 6
              </span>
            </div>
            <ChecklistItem
              done={checks.nameChosen}
              label="Name chosen"
              hint="Add a candidate and mark it as chosen."
            />
            <ChecklistItem
              done={checks.paletteValid}
              label="All 7 palette colours valid"
              hint="Every slot must be a 6-digit hex."
            />
            <ChecklistItem
              done={checks.personalityPicked}
              label="Personality picked"
              hint="Pick at least one trait (max 3)."
            />
            <ChecklistItem
              done={checks.copyFilled}
              label="Tagline / mission / audience ≥ 20 chars"
              hint="Finish the Direction section."
            />
            <ChecklistItem
              done={checks.briefOnDisk}
              label="Brand brief saved"
              hint="Hit 'Save brief' in the Logo section."
            />
            <ChecklistItem
              done={checks.logoPackOnDisk}
              label="Logo pack generated"
              hint="Hit 'Generate logo pack'."
            />
          </div>
        </div>
      </div>
      {/*
         Provider picker — modal that asks which LLM to use. Reused
         for both logo-candidate generation and full-pack generation
         via pickerIntent. Mounted once at the top level so it overlays
         the scrollable tab content cleanly.
      */}
      <ProviderPickerDialog
        isOpen={pickerOpen}
        ventureId={venture.id}
        title={
          pickerIntent === "full-pack"
            ? "Which AI should generate the full brand pack?"
            : "Which AI should generate the logo candidates?"
        }
        description={
          pickerIntent === "full-pack"
            ? "6 assets in parallel: email header, X / LinkedIn / OG banners, email signature, and a brand guide MD. Pick whichever subscription you'd rather burn today."
            : "4 logo archetypes generated in parallel: wordmark, lettermark, icon+wordmark, and abstract mark."
        }
        onCancel={() => {
          setPickerOpen(false);
          setPickerIntent(null);
        }}
        onConfirm={(r) => handlePickerConfirm(r.providerId)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * One card in the 2×2 logo-candidate grid. Renders the SVG via a
 * base64 data URL (safer than dangerouslySetInnerHTML — the browser
 * sandbox is doing the parsing) with a skeleton/placeholder while
 * generation is in flight and an error banner if the model returned
 * invalid SVG. "Use this logo" emits up to the parent which handles
 * palette extraction + persistence.
 */
function LogoCandidateCard({
  candidate,
  isChosen,
  isGenerating,
  onUse,
}: {
  candidate: LogoCandidate & { error?: string };
  isChosen: boolean;
  isGenerating: boolean;
  onUse: () => void;
}) {
  const archetypeTitle: Record<LogoArchetype, string> = {
    wordmark: "Wordmark",
    lettermark: "Lettermark",
    "icon-wordmark": "Icon + Wordmark",
    "abstract-mark": "Abstract Mark",
  };
  const dataUrl = candidate.svg
    ? `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(candidate.svg)))}`
    : null;

  return (
    <div
      style={{
        border: `2px solid ${isChosen ? "#6366F1" : "#E5E7EB"}`,
        background: isChosen ? "#EEF2FF" : "#FFFFFF",
        borderRadius: 10,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        transition: "border-color 0.12s, background 0.12s",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>
          {archetypeTitle[candidate.archetype]}
        </span>
        {isChosen && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: "1px 6px",
              borderRadius: 3,
              background: "#6366F1",
              color: "#FFFFFF",
              letterSpacing: 0.3,
            }}
          >
            CHOSEN
          </span>
        )}
      </div>
      <div
        style={{
          height: 140,
          background: "#F9FAFB",
          border: "1px solid #F3F4F6",
          borderRadius: 6,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {dataUrl ? (
          <img
            src={dataUrl}
            alt={archetypeTitle[candidate.archetype]}
            style={{ maxWidth: "90%", maxHeight: "90%" }}
          />
        ) : candidate.error ? (
          <div
            style={{
              fontSize: 11,
              color: "#991B1B",
              padding: 8,
              textAlign: "center",
            }}
          >
            {candidate.error}
          </div>
        ) : (
          <div
            style={{
              fontSize: 11,
              color: "#9CA3AF",
              padding: 8,
              textAlign: "center",
            }}
          >
            {isGenerating ? "Generating…" : "Pending"}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onUse}
        disabled={!candidate.svg}
        style={{
          padding: "7px 10px",
          fontSize: 12,
          fontWeight: 600,
          border: "1px solid #D1D5DB",
          borderRadius: 6,
          background: candidate.svg ? "#FFFFFF" : "#F3F4F6",
          color: candidate.svg ? "#111827" : "#9CA3AF",
          cursor: candidate.svg ? "pointer" : "not-allowed",
        }}
      >
        {isChosen ? "Chosen ✓" : "Use this logo"}
      </button>
    </div>
  );
}

/**
 * One row in the full-pack progress list. Shows the asset title, a
 * status dot (idle/running/done/error), and the error message when
 * the generation for this slot failed.
 */
function PackAssetRow({
  entry,
}: {
  entry: {
    spec: BrandAssetSpec;
    status: "idle" | "running" | "done" | "error";
    content?: string;
    error?: string;
  };
}) {
  const { spec, status, error } = entry;
  const colorByStatus: Record<typeof status, { bg: string; fg: string; label: string }> = {
    idle: { bg: "#F3F4F6", fg: "#6B7280", label: "Pending" },
    running: { bg: "#EFF6FF", fg: "#1D4ED8", label: "Generating…" },
    done: { bg: "#ECFDF5", fg: "#047857", label: "Done" },
    error: { bg: "#FEF2F2", fg: "#B91C1C", label: "Failed" },
  };
  const c = colorByStatus[status];
  return (
    <div
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
      <span style={{ flex: 1, color: "#111827" }}>{spec.title}</span>
      <span style={{ fontSize: 11, color: "#9CA3AF" }}>
        <code>{spec.relPath}</code>
      </span>
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          padding: "2px 8px",
          borderRadius: 999,
          background: c.bg,
          color: c.fg,
        }}
      >
        {c.label}
      </span>
      {error && (
        <span
          title={error}
          style={{
            fontSize: 11,
            color: "#B91C1C",
            maxWidth: 240,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {error}
        </span>
      )}
    </div>
  );
}

function Section({
  title,
  icon,
  open,
  onToggle,
  children,
}: {
  title: string;
  icon: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "#FFFFFF",
        border: "1px solid #E5E7EB",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: "100%",
          padding: "14px 18px",
          borderBottom: open ? "1px solid #F3F4F6" : "none",
          background: "#F9FAFB",
          display: "flex",
          alignItems: "center",
          gap: 8,
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ fontSize: 16 }}>{icon}</span>
        <h4 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#111827", flex: 1 }}>
          {title}
        </h4>
        <span style={{ fontSize: 14, color: "#6B7280" }}>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div style={{ padding: "18px", display: "flex", flexDirection: "column", gap: 16 }}>
          {children}
        </div>
      )}
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

// ─── Candidate card ─────────────────────────────────────────────────────

function CandidateCard({
  candidate,
  chosen,
  checking,
  onChoose,
  onRemove,
  onCheck,
  onOpenTrademark,
  onSetTrademark,
  onUpdateNotes,
}: {
  candidate: NamingCandidate;
  chosen: boolean;
  checking: boolean;
  onChoose: () => void;
  onRemove: () => void;
  onCheck: () => void;
  /**
   * pt.31b: takes a jurisdiction so the card can render one launcher per
   * office (UK / US / WIPO). Caller (BrandTab) decides what to do with
   * the jurisdiction — currently sets `trademarkStatus[jurisdiction]` to
   * `restricted` so the user remembers to flip the verdict after looking.
   */
  onOpenTrademark: (jurisdiction: TrademarkJurisdiction) => void;
  /**
   * pt.32a: per-jurisdiction verdict setter. The card renders one row
   * per jurisdiction in TRADEMARK_JURISDICTIONS, so the parent needs
   * the jurisdiction key to know which slot to update.
   */
  onSetTrademark: (jurisdiction: TrademarkJurisdiction, s: AvailabilityStatus) => void;
  onUpdateNotes: (s: string) => void;
}) {
  const confidence = deriveBrandConfidence(candidate);
  const confCfg = {
    green: { bg: "#ECFDF5", border: "#A7F3D0", color: "#065F46", label: "Green — safe to proceed" },
    amber: {
      bg: "#FFFBEB",
      border: "#FDE68A",
      color: "#92400E",
      label: "Amber — build but don't brand-lock yet",
    },
    red: { bg: "#FEF2F2", border: "#FECACA", color: "#991B1B", label: "Red — don't use" },
    unknown: { bg: "#F9FAFB", border: "#E5E7EB", color: "#6B7280", label: "Unknown — run checks" },
  }[confidence];

  return (
    <div
      style={{
        border: `2px solid ${chosen ? "#6366F1" : confCfg.border}`,
        background: chosen ? "#EEF2FF" : confCfg.bg,
        borderRadius: 8,
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            fontSize: 16,
            fontWeight: 800,
            color: "#111827",
            flex: 1,
          }}
        >
          {candidate.name}
        </span>
        {candidate.style && (
          <span
            style={{
              fontSize: 10,
              color: "#6B7280",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            {candidate.style}
          </span>
        )}
        <span
          title={confCfg.label}
          style={{
            fontSize: 10,
            padding: "2px 8px",
            borderRadius: 999,
            background: confCfg.color,
            color: "#FFFFFF",
            fontWeight: 700,
            textTransform: "uppercase",
          }}
        >
          {confidence}
        </span>
        <button
          type="button"
          onClick={onChoose}
          title={chosen ? "Unpick this candidate" : "Mark as chosen name"}
          style={{
            padding: "4px 10px",
            fontSize: 11,
            background: chosen ? "#6366F1" : "#FFFFFF",
            color: chosen ? "#FFFFFF" : "#6366F1",
            border: "1px solid #6366F1",
            borderRadius: 4,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {chosen ? "✓ Chosen" : "Choose"}
        </button>
        <button type="button" onClick={onRemove} title="Remove candidate" style={iconButtonStyle}>
          ×
        </button>
      </div>
      {candidate.rationale && (
        <p style={{ margin: 0, fontSize: 12, color: "#374151", lineHeight: 1.5 }}>
          {candidate.rationale}
        </p>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={onCheck}
          disabled={checking}
          style={{
            padding: "5px 10px",
            fontSize: 11,
            background: checking ? "#F3F4F6" : "#FFFFFF",
            border: "1px solid #D1D5DB",
            borderRadius: 4,
            cursor: checking ? "not-allowed" : "pointer",
            fontWeight: 600,
            color: "#374151",
          }}
        >
          {checking ? "⏳ Checking…" : "🔎 Check domains + socials"}
        </button>
        {/* pt.31b: one launcher per jurisdiction. Each opens the
            office's public search and stamps the candidate's
            trademarkStatus[jurisdiction] = "restricted" so the user
            remembers to look + flip verdict. UK is the default left-
            most because the project's primary jurisdiction is UK; US +
            WIPO are extra coverage when the venture targets export. */}
        {TRADEMARK_JURISDICTIONS.map((j) => (
          <button
            key={j}
            type="button"
            onClick={() => onOpenTrademark(j)}
            title={`Open ${TRADEMARK_JURISDICTION_LABELS[j]} trademark search in your browser`}
            style={{
              padding: "5px 10px",
              fontSize: 11,
              background: "#FFFFFF",
              border: "1px solid #D1D5DB",
              borderRadius: 4,
              cursor: "pointer",
              fontWeight: 600,
              color: "#374151",
            }}
          >
            ⚖️ {TRADEMARK_JURISDICTION_LABELS[j]} ↗
          </button>
        ))}
      </div>

      {/* Domains */}
      {Object.keys(candidate.domainStatus).length > 0 && (
        <StatusStrip
          title="Domains"
          entries={Object.entries(candidate.domainStatus).map(([k, v]) => ({ key: k, check: v }))}
        />
      )}

      {/* Socials */}
      {Object.keys(candidate.socialStatus).length > 0 && (
        <StatusStrip
          title="Socials"
          entries={SOCIAL_PLATFORMS.filter((p) => candidate.socialStatus[p]).map((p) => ({
            key: SOCIAL_PLATFORM_LABELS[p],
            check: candidate.socialStatus[p]!,
            href: socialProfileUrl(p, candidate.name),
          }))}
        />
      )}

      {/* pt.32a: one verdict row per jurisdiction. Always rendered (vs
          conditionally on .uk having an entry) so the user can flip
          status for any jurisdiction without first triggering its
          launcher. The fixed-width label keeps the rows visually
          aligned regardless of which office is currently set. */}
      {TRADEMARK_JURISDICTIONS.map((jurisdiction) => {
        const cur = candidate.trademarkStatus[jurisdiction]?.status ?? "unknown";
        return (
          <div
            key={jurisdiction}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 11,
            }}
          >
            <span style={{ color: "#6B7280", fontWeight: 600, minWidth: 110 }}>
              Trademark ({TRADEMARK_JURISDICTION_LABELS[jurisdiction]}):
            </span>
            {(["available", "taken", "restricted", "unknown"] as const).map((s) => {
              const active = cur === s;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => onSetTrademark(jurisdiction, s)}
                  style={{
                    padding: "3px 8px",
                    fontSize: 10,
                    background: active ? statusColors(s).bg : "#FFFFFF",
                    color: active ? statusColors(s).fg : "#6B7280",
                    border: `1px solid ${active ? statusColors(s).fg : "#E5E7EB"}`,
                    borderRadius: 4,
                    cursor: "pointer",
                    fontWeight: 600,
                    textTransform: "capitalize",
                  }}
                >
                  {s}
                </button>
              );
            })}
          </div>
        );
      })}

      {/* Notes */}
      <input
        type="text"
        value={candidate.notes}
        onChange={(e) => onUpdateNotes(e.target.value)}
        placeholder="Notes (optional)"
        style={{
          ...inputStyle,
          fontSize: 12,
          padding: "5px 8px",
          background: "rgba(255,255,255,0.7)",
        }}
      />
    </div>
  );
}

function StatusStrip({
  title,
  entries,
}: {
  title: string;
  entries: Array<{ key: string; check: AvailabilityCheck; href?: string }>;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, flexWrap: "wrap" }}>
      <span style={{ color: "#6B7280", fontWeight: 600, minWidth: 80 }}>{title}:</span>
      {entries.map(({ key, check, href }) => {
        const cfg = statusColors(check.status);
        const body = (
          <span
            key={key}
            title={check.detail || check.status}
            style={{
              padding: "3px 8px",
              background: cfg.bg,
              color: cfg.fg,
              border: `1px solid ${cfg.border}`,
              borderRadius: 4,
              fontSize: 10,
              fontWeight: 600,
              cursor: href ? "pointer" : "default",
            }}
          >
            {key}: {check.status}
          </span>
        );
        if (href) {
          return (
            <button
              key={key}
              type="button"
              onClick={() => invoke("open_url", { url: href }).catch(() => {})}
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
              title={`${check.detail || check.status} — click to open ${href}`}
            >
              {body}
            </button>
          );
        }
        return body;
      })}
    </div>
  );
}

function statusColors(status: AvailabilityStatus): {
  bg: string;
  fg: string;
  border: string;
} {
  switch (status) {
    case "available":
      return { bg: "#ECFDF5", fg: "#065F46", border: "#A7F3D0" };
    case "taken":
      return { bg: "#FEF2F2", fg: "#991B1B", border: "#FECACA" };
    case "parked":
      return { bg: "#FEF3C7", fg: "#92400E", border: "#FDE68A" };
    case "restricted":
      return { bg: "#FFFBEB", fg: "#92400E", border: "#FDE68A" };
    case "error":
      return { bg: "#F3F4F6", fg: "#6B7280", border: "#E5E7EB" };
    case "unknown":
      return { bg: "#F9FAFB", fg: "#6B7280", border: "#E5E7EB" };
  }
}

// ─── Palette editor ─────────────────────────────────────────────────────

function PaletteEditor({
  palette,
  onChange,
}: {
  palette: ColorPalette;
  onChange: (patch: Partial<ColorPalette>) => void;
}) {
  const slots: Array<{ key: keyof ColorPalette; label: string }> = [
    { key: "primary", label: "Primary" },
    { key: "secondary", label: "Secondary" },
    { key: "accent", label: "Accent" },
    { key: "background", label: "Background" },
    { key: "surface", label: "Surface" },
    { key: "text", label: "Text" },
    { key: "textMuted", label: "Text Muted" },
  ];

  const bgText = contrastRatio(palette.background, palette.text);
  const bgPrimary = contrastRatio(palette.background, palette.primary);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
        {slots.map(({ key, label }) => {
          const value = palette[key];
          const valid = isValidHex(value);
          return (
            <div key={key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: "#374151" }}>{label}</span>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 6px",
                  border: `1px solid ${valid ? "#D1D5DB" : "#FECACA"}`,
                  borderRadius: 6,
                  background: "#FFFFFF",
                }}
              >
                <span
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 4,
                    background: valid ? value : "#FFFFFF",
                    border: "1px solid rgba(0,0,0,0.1)",
                    flexShrink: 0,
                  }}
                />
                <input
                  type="text"
                  value={value}
                  onChange={(e) => onChange({ [key]: e.target.value } as Partial<ColorPalette>)}
                  spellCheck={false}
                  style={{
                    flex: 1,
                    fontSize: 12,
                    border: "none",
                    outline: "none",
                    fontFamily: "'SFMono-Regular', Consolas, monospace",
                    background: "transparent",
                    color: valid ? "#111827" : "#991B1B",
                    minWidth: 0,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* WCAG contrast pills */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11 }}>
        <ContrastPill label="Body text on background" ratio={bgText} min={4.5} />
        <ContrastPill
          label="Primary on background"
          ratio={bgPrimary}
          min={3.0}
          note="UI elements (≥ 3:1)"
        />
      </div>
    </div>
  );
}

function ContrastPill({
  label,
  ratio,
  min,
  note,
}: {
  label: string;
  ratio: number;
  min: number;
  note?: string;
}) {
  const pass = ratio >= min;
  const cfg = pass
    ? { bg: "#ECFDF5", color: "#065F46", border: "#A7F3D0" }
    : { bg: "#FEF2F2", color: "#991B1B", border: "#FECACA" };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span
        style={{
          padding: "3px 8px",
          fontSize: 10,
          fontWeight: 700,
          background: cfg.bg,
          color: cfg.color,
          border: `1px solid ${cfg.border}`,
          borderRadius: 4,
          fontFamily: "'SFMono-Regular', Consolas, monospace",
        }}
      >
        {ratio.toFixed(2)}:1 {pass ? "✓" : "✗"}
      </span>
      <span style={{ color: "#6B7280" }}>
        {label}
        {note ? ` · ${note}` : ""}
        {pass ? "" : ` · WCAG AA ≥ ${min}:1`}
      </span>
    </div>
  );
}

// ─── Typography preview ─────────────────────────────────────────────────

function TypographyPreview({
  palette,
  typography,
  sample,
}: {
  palette: ColorPalette;
  typography: Typography;
  sample: string;
}) {
  const name = sample || "Preview";
  return (
    <div
      style={{
        padding: "18px 20px",
        borderRadius: 8,
        background: palette.background,
        border: `1px solid ${palette.surface === palette.background ? "#E5E7EB" : palette.surface}`,
      }}
    >
      <div
        style={{
          fontFamily: `${typography.headingFont}, Inter, sans-serif`,
          fontWeight: typography.headingWeight,
          fontSize: 28,
          color: palette.primary,
          letterSpacing: -0.5,
        }}
      >
        {name}
      </div>
      <div
        style={{
          fontFamily: `${typography.bodyFont}, Inter, sans-serif`,
          fontWeight: typography.bodyWeight,
          fontSize: 14,
          color: palette.text,
          marginTop: 6,
          lineHeight: 1.5,
        }}
      >
        The brand speaks in complete sentences. Short, confident, specific.
      </div>
      <div
        style={{
          fontFamily: `${typography.bodyFont}, Inter, sans-serif`,
          fontSize: 12,
          color: palette.textMuted,
          marginTop: 4,
        }}
      >
        Supporting copy sits at muted contrast, still legible.
      </div>
    </div>
  );
}

// ─── Logo preview ───────────────────────────────────────────────────────

function LogoPreview({ rootPath }: { rootPath: string }) {
  const [svg, setSvg] = useState<{ light: string; dark: string; icon: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      invoke<string>("read_file", {
        path: joinPath(getLogoExportsDir(rootPath), "logo.svg"),
      }).catch(() => ""),
      invoke<string>("read_file", {
        path: joinPath(getLogoExportsDir(rootPath), "logo-dark.svg"),
      }).catch(() => ""),
      invoke<string>("read_file", {
        path: joinPath(getLogoExportsDir(rootPath), "logo-icon.svg"),
      }).catch(() => ""),
    ]).then(([light, dark, icon]) => {
      if (cancelled) return;
      setSvg({ light, dark, icon });
    });
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  if (!svg) return null;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr auto",
        gap: 12,
        padding: 12,
        background: "#F9FAFB",
        borderRadius: 8,
      }}
    >
      <div
        style={{
          background: "#FFFFFF",
          padding: 14,
          borderRadius: 6,
          border: "1px solid #E5E7EB",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          dangerouslySetInnerHTML={{ __html: svg.light }}
          style={{ width: "100%", maxHeight: 80 }}
        />
      </div>
      <div
        style={{
          background: "#111827",
          padding: 14,
          borderRadius: 6,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          dangerouslySetInnerHTML={{ __html: svg.dark }}
          style={{ width: "100%", maxHeight: 80 }}
        />
      </div>
      <div
        style={{
          background: "#FFFFFF",
          padding: 14,
          borderRadius: 6,
          border: "1px solid #E5E7EB",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 80,
        }}
      >
        <div dangerouslySetInnerHTML={{ __html: svg.icon }} style={{ width: 48, height: 48 }} />
      </div>
    </div>
  );
}

// ─── Pack summary ───────────────────────────────────────────────────────

function PackSummary({
  rootPath,
  hasBrief,
  hasLogo,
  hasTokens,
  conceptCount,
  onOpenFolder,
}: {
  rootPath: string;
  hasBrief: boolean;
  hasLogo: boolean;
  hasTokens: boolean;
  conceptCount: number;
  onOpenFolder: () => void;
}) {
  const rows = [
    { label: "Brand brief", path: "03_brand/brand-kit/brand-brief.json", ok: hasBrief },
    { label: "Logo pack", path: "03_brand/logo/exports/", ok: hasLogo },
    { label: "Design tokens", path: "03_brand/logo/exports/tokens.json", ok: hasTokens },
    {
      label: "Concept briefs",
      path: `03_brand/logo/concepts/ (${conceptCount} files)`,
      ok: conceptCount > 0,
    },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((r) => (
          <div
            key={r.label}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "7px 12px",
              background: "#FFFFFF",
              border: "1px solid #E5E7EB",
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            <span style={{ fontSize: 14 }}>{r.ok ? "✅" : "⬜"}</span>
            <span style={{ fontWeight: 600, color: "#111827", minWidth: 120 }}>{r.label}</span>
            <span
              style={{
                flex: 1,
                color: "#6B7280",
                fontFamily: "'SFMono-Regular', Consolas, monospace",
                fontSize: 12,
              }}
            >
              {r.path}
            </span>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={onOpenFolder}
        style={{
          alignSelf: "flex-start",
          padding: "8px 14px",
          background: "#111827",
          color: "#FFFFFF",
          border: "none",
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        📂 Open 03_brand/ folder
      </button>
      <p style={{ margin: 0, fontSize: 11, color: "#9CA3AF" }}>
        Root: <code>{rootPath}</code>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LLM response parser
// ---------------------------------------------------------------------------

/**
 * Extract a candidates array from a raw LLM response. The prompt asks
 * for a fenced ```json block; we fall through to plain fenced + bare
 * brace match so a model that fumbles the fence still parses.
 */
function extractCandidatesFromResponse(raw: string): Array<{
  name: string;
  style?: string;
  rationale?: string;
}> {
  const text = raw.trim();
  const matchers = [/```json\s*\n([\s\S]*?)\n```/i, /```\s*\n([\s\S]*?)\n```/, /(\{[\s\S]*\})/];
  for (const re of matchers) {
    const m = re.exec(text);
    if (!m || !m[1]) continue;
    try {
      const parsed = JSON.parse(m[1]);
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as Record<string, unknown>).candidates)
      ) {
        const candidates = (parsed as { candidates: unknown[] }).candidates;
        return (
          candidates
            .map((c) => {
              if (!c || typeof c !== "object") return null;
              const r = c as Record<string, unknown>;
              const name = typeof r.name === "string" ? r.name.trim() : "";
              if (!name) return null;
              return {
                name,
                style: typeof r.style === "string" ? r.style.trim() : undefined,
                rationale: typeof r.rationale === "string" ? r.rationale.trim() : undefined,
              };
            })
            // Predicate must match the .map() output shape exactly. The map
            // returns `{ name; style: string | undefined; rationale: string | undefined }`
            // (properties always present, value may be undefined) — that is
            // NOT the same TS shape as `{ style?: string }` (property
            // optional). NonNullable strips the `| null` from the inferred
            // type without restating the whole shape and risking drift.
            .filter((x): x is NonNullable<typeof x> => x !== null)
        );
      }
    } catch {
      /* try next matcher */
    }
  }
  return [];
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

const iconButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  color: "#6B7280",
  fontSize: 14,
  padding: "2px 6px",
  borderRadius: 4,
  lineHeight: 1,
};

function primaryButton(disabled: boolean, color = "#6366F1"): React.CSSProperties {
  return {
    padding: "8px 14px",
    background: disabled ? "#E5E7EB" : color,
    color: disabled ? "#9CA3AF" : "#FFFFFF",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

// Guard: ensure BrandPersonalitySchema is referenced so tree-shakers don't
// drop the runtime validator — we re-use it implicitly when saving the
// brief (through BrandBriefSchema), but an explicit reference prevents an
// unused-import warning in strict tsconfig setups.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
BrandPersonalitySchema;
