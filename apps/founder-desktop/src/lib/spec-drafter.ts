/**
 * Spec drafter (pt.42a) — orchestrates the "Draft with AI" flow on the
 * SpecTab. Reads the venture's brand brief + research reports, asks the
 * active LLM to draft a complete `ProductSpecCanvas`, and returns a
 * Zod-validated canvas (or an actionable error message).
 *
 * The SpecTab's `SpecDraftPanel` consumes the result and offers per-section
 * Replace / Merge / Skip controls so the founder's existing canvas is
 * never silently clobbered.
 *
 * Why a separate module from `llm-client.ts`:
 *   - It carries the spec-specific input assembly (brief + research dir
 *     traversal + per-file truncation budgeting) that doesn't belong in
 *     the generic streaming wrapper.
 *   - It owns the JSON-extraction + Zod-validation contract — the
 *     panel renders proposed sections off the validated canvas only.
 *   - Easy to add a CLI seed harness later that reuses the same drafter
 *     under `node` (the streamChat call would swap, but the prompt
 *     assembly + extract+validate stays).
 *
 * Cancellation: pass an `AbortSignal`. Same semantics as `streamChat` —
 * `controller.abort()` cancels the in-flight provider request and the
 * promise resolves with `{ ok: false, error: "Drafting cancelled." }`.
 */
import { invoke } from "@tauri-apps/api/core";
import {
  ProductSpecCanvasSchema,
  type ProductSpecCanvas,
  type Venture,
  type VentureManifest,
} from "@founder-os/domain";
import { getBrandKitDir, getStagePath } from "@founder-os/workspace-core";
import { specDraftPrompt } from "@founder-os/prompts";
import { getProvider, type LlmProviderId } from "@founder-os/llm-providers";
import * as db from "./db.js";
import { pickActiveProvider, streamChat } from "./llm-client.js";

/** Mirror of the Rust `list_dir_recursive` return shape. Same shape used
 *  by `artifacts-scan.ts` — kept inlined here so this module doesn't
 *  reach across the lib boundary for one type. */
type RustDirEntry = {
  path: string;
  isDir: boolean;
  sizeBytes: number;
  modifiedAt: string | null;
};

/** Result of a draft attempt. The discriminated union forces the caller
 *  to branch on `ok` before touching `canvas` — no unsafe casts. */
export type SpecDraftResult =
  | {
      ok: true;
      canvas: ProductSpecCanvas;
      provider: LlmProviderId;
      /** The model id resolved via `llm_settings.model || catalog.defaultModel`. */
      model: string;
      /** Provider display name for the panel header. */
      providerDisplayName: string;
    }
  | { ok: false; error: string };

export type DraftSpecCanvasArgs = {
  venture: Venture;
  manifest: VentureManifest;
  /** Cancel in-flight provider call. Same semantics as `streamChat.signal`. */
  signal?: AbortSignal;
  /** Forwarded to `streamChat.onDelta` so the panel can show a token-counter
   *  / "drafting…" pulse if it wants. We don't render partial JSON because
   *  partial JSON is unparseable; the delta is just a liveness signal. */
  onDelta?: (delta: string) => void;
};

/**
 * Per-file size cap when reading research reports. The drafter
 * concatenates all .md files under `01_research/<appType>/` into the
 * user prompt; without a cap a single bloated report could blow the
 * model's context. Tuned to leave room for ~3 reports under TOTAL_CAP.
 */
const PER_FILE_RESEARCH_CHARS = 8000;
/** Aggregate cap across all research reports. */
const TOTAL_RESEARCH_CHARS = 24000;

/**
 * Draft a `ProductSpecCanvas` for the given venture using the active
 * LLM provider. See module docstring for the contract.
 */
export async function draftSpecCanvas(
  args: DraftSpecCanvasArgs
): Promise<SpecDraftResult> {
  // 1. Pick provider — respects per-venture override, then global, then
  // first-usable. If nothing's configured, surface a clear error pointing
  // at the Options tab.
  const provider = await pickActiveProvider(args.venture.id);
  if (!provider) {
    return {
      ok: false,
      error:
        "No LLM provider configured. Open the Options tab to add an API key.",
    };
  }
  const setting = await db.getLlmSetting(provider);
  const catalog = getProvider(provider);
  const model = setting?.model || catalog.defaultModel;

  // 2. Read the brand brief + research reports. Both are best-effort —
  // missing inputs produce a thinner draft, not an error. The prompt
  // tells the model to lean on the manifest if the brief is absent.
  const brandBriefJson = await tryReadBrandBrief(args.venture.rootPath);
  const researchSummary = await tryReadResearchReports(
    args.venture.rootPath,
    args.manifest.appType
  );

  // 3. Build the prompt.
  const { system, user } = specDraftPrompt({
    ventureName: args.venture.name,
    appType: args.manifest.appType,
    manifest: args.manifest,
    brandBriefJson,
    researchSummary,
  });

  // 4. Stream. Single user turn — drafting is one-shot, no conversation
  // history. Temperature kept low because we want consistent JSON shape;
  // the prompt has plenty of latitude for content variation.
  let raw: string;
  try {
    raw = await streamChat({
      provider,
      messages: [{ role: "user", content: user }],
      system,
      maxTokens: 8000,
      temperature: 0.3,
      signal: args.signal,
      onDelta: args.onDelta,
    });
  } catch (err) {
    // AbortError → cancelled by user. Every other error → provider /
    // network / auth.
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "Drafting cancelled." };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 5. Extract JSON. The model is asked to fence the block; the fallback
  // greedy-bracket grab covers providers that drift on instruction.
  const json = extractJsonBlock(raw);
  if (!json) {
    return {
      ok: false,
      error:
        "Couldn't find a JSON block in the model's reply. Try again — sometimes the provider drifts on the format.",
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch (err) {
    return {
      ok: false,
      error: `Model returned invalid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // 6. Stamp authoritative fields and validate. ventureId / timestamps
  // / version are NOT trusted from the model — the UI owns them. The
  // drafter parses the rest with Zod's `safeParse` so any shape drift
  // surfaces as an actionable error rather than a runtime crash on the
  // panel render.
  const now = new Date().toISOString();
  const stamped = {
    ...(parsedJson as Record<string, unknown>),
    ventureId: args.venture.id,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };

  const result = ProductSpecCanvasSchema.safeParse(stamped);
  if (!result.success) {
    const summary = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      error: `Model output didn't match the canvas schema (${summary})${
        result.error.issues.length > 3 ? ` and ${result.error.issues.length - 3} more` : ""
      }. Try again, or switch to a stronger model in the Options tab.`,
    };
  }

  return {
    ok: true,
    canvas: result.data,
    provider,
    model,
    providerDisplayName: catalog.displayName,
  };
}

// ---------------------------------------------------------------------------
// Input loaders — both best-effort. Missing files / dirs return null
// rather than throw; the prompt has explicit branches for either case.
// ---------------------------------------------------------------------------

/**
 * Read the brand-brief.json verbatim. We pass it through as raw JSON
 * rather than Zod-parsing because (a) the model handles loose shape
 * fine, and (b) we don't want a brand-brief schema bump to break the
 * drafter.
 */
async function tryReadBrandBrief(ventureRoot: string): Promise<string | null> {
  const path = `${getBrandKitDir(ventureRoot)}/brand-brief.json`;
  try {
    const exists = await invoke<boolean>("path_exists", { path });
    if (!exists) return null;
    return await invoke<string>("read_file", { path });
  } catch (err) {
    console.warn("[spec-drafter] brand brief read failed", err);
    return null;
  }
}

/**
 * Read every .md file under `01_research/<appType>/`, concatenate with
 * filename headers, and apply per-file + total truncation caps. SaaS
 * ventures get the Core-4 reports here; other appTypes may have their
 * own research dirs in the future — for now we look for `<appType>/`
 * and gracefully no-op if it doesn't exist.
 */
async function tryReadResearchReports(
  ventureRoot: string,
  appType: string
): Promise<string | null> {
  const dir = `${getStagePath(ventureRoot, "research")}/${appType}`;
  try {
    const exists = await invoke<boolean>("path_exists", { path: dir });
    if (!exists) return null;
    const entries = await invoke<RustDirEntry[]>("list_dir_recursive", {
      path: dir,
    });
    const mdFiles = entries
      .filter((e) => !e.isDir && e.path.toLowerCase().endsWith(".md"))
      // Stable order so re-drafting the same venture gives the same prompt.
      .sort((a, b) => a.path.localeCompare(b.path));
    if (mdFiles.length === 0) return null;

    const parts: string[] = [];
    let total = 0;
    let included = 0;
    for (const file of mdFiles) {
      let text: string;
      try {
        text = await invoke<string>("read_file", { path: file.path });
      } catch (err) {
        console.warn(`[spec-drafter] read failed for ${file.path}`, err);
        continue;
      }
      const trimmed =
        text.length > PER_FILE_RESEARCH_CHARS
          ? text.slice(0, PER_FILE_RESEARCH_CHARS) + "\n\n[... truncated ...]"
          : text;
      const filename = file.path.split(/[\\/]/).pop() ?? file.path;
      parts.push(`### ${filename}\n${trimmed}`);
      total += trimmed.length;
      included += 1;
      if (total > TOTAL_RESEARCH_CHARS) {
        const remaining = mdFiles.length - included;
        if (remaining > 0) {
          parts.push(
            `\n[... ${remaining} additional research file${remaining === 1 ? "" : "s"} omitted to fit context ...]`
          );
        }
        break;
      }
    }
    return parts.join("\n\n---\n\n");
  } catch (err) {
    console.warn("[spec-drafter] research reports read failed", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// JSON extraction — fenced-first, then greedy-bracket fallback.
// ---------------------------------------------------------------------------

/**
 * Pull the JSON canvas out of the model's reply.
 *
 * Strategy:
 *   1. Look for a fenced block (```json ... ``` or ``` ... ```). The
 *      prompt asks for this explicitly; most providers comply.
 *   2. Fall back to the substring between the first `{` and last `}`.
 *      Catches cases where the model forgot the fence but did emit a
 *      single JSON object surrounded by prose. JSON.parse on the
 *      caller side filters out garbage.
 *
 * Returns null only when neither strategy finds anything that looks
 * like a JSON object — the caller surfaces a "couldn't find JSON"
 * error in that case so the founder can retry.
 */
function extractJsonBlock(text: string): string | null {
  // 1. Fenced block — prefer ```json, but accept any fenced code with
  // a JSON-shaped payload.
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (fenceMatch && fenceMatch[1].trim().length > 0) {
    return fenceMatch[1];
  }

  // 2. Greedy bracket fallback. Doesn't validate balance — JSON.parse
  // will reject if the slice is malformed.
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) return null;
  return text.slice(firstBrace, lastBrace + 1);
}
