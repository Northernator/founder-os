import {
  type ScreensCanvas,
  ScreensCanvasSchema,
  type Venture,
  type VentureManifest,
} from "@founder-os/domain";
import { type LlmProviderId, getProvider } from "@founder-os/llm-providers";
import { optimize } from "@founder-os/prompt-master";
import { screensDraftPrompt } from "@founder-os/prompts";
import { getBrandKitDir, getSpecCanvasPath, getStagePath } from "@founder-os/workspace-core";
/**
 * Screens drafter (pt.47) — orchestrates the "Draft with AI" flow on
 * the ScreensTab. Reads the venture's spec canvas + brand brief +
 * research reports, asks the active LLM to draft a complete
 * `ScreensCanvas`, and returns a Zod-validated canvas (or an
 * actionable error message).
 *
 * Mirror of `spec-drafter.ts` — same provider resolution, same
 * streaming + extract + validate contract, same cancellation
 * semantics. The ScreensTab's `ScreensDraftPanel` consumes the result
 * and offers per-section Replace / Merge / Skip controls so the
 * founder's existing canvas is never silently clobbered.
 *
 * Why a separate module from `spec-drafter.ts`:
 *   - Different inputs (spec is the primary input here, was an
 *     output for spec-drafter). Different prompt assembly logic.
 *   - Different output schema (ScreensCanvas vs ProductSpecCanvas).
 *   - Decoupling means schema bumps on either canvas don't ripple
 *     through the other drafter's parse path.
 *
 * Cancellation: pass an `AbortSignal`. Same semantics as `streamChat` —
 * `controller.abort()` cancels the in-flight provider request and the
 * promise resolves with `{ ok: false, error: "Drafting cancelled." }`.
 */
import { invoke } from "@tauri-apps/api/core";
import * as db from "./db.js";
import { pickActiveProvider, streamChat } from "./llm-client.js";

/** Mirror of the Rust `list_dir_recursive` return shape. Inlined
 *  here (and in spec-drafter.ts) so this module doesn't reach across
 *  the lib boundary for one type. */
type RustDirEntry = {
  path: string;
  isDir: boolean;
  sizeBytes: number;
  modifiedAt: string | null;
};

/** Result of a draft attempt. Discriminated union matches
 *  SpecDraftResult shape so the panel state machines can share
 *  vocabulary. */
export type ScreensDraftResult =
  | {
      ok: true;
      canvas: ScreensCanvas;
      provider: LlmProviderId;
      /** The model id resolved via `llm_settings.model || catalog.defaultModel`. */
      model: string;
      /** Provider display name for the panel header. */
      providerDisplayName: string;
    }
  | { ok: false; error: string };

export type DraftScreensCanvasArgs = {
  venture: Venture;
  manifest: VentureManifest;
  /** Cancel in-flight provider call. Same semantics as `streamChat.signal`. */
  signal?: AbortSignal;
  /** Forwarded to `streamChat.onDelta` for the panel's liveness pulse.
   *  Partial JSON isn't rendered — the delta is just a heartbeat. */
  onDelta?: (delta: string) => void;
};

/**
 * Per-file size cap when reading research reports. Same budget as
 * spec-drafter — the screens drafter doesn't need as much research
 * context as the spec drafter (spec is the primary input here), but
 * we keep the budget identical so round-trip costs are consistent
 * across the two drafters.
 */
const PER_FILE_RESEARCH_CHARS = 8000;
/** Aggregate cap across all research reports. */
const TOTAL_RESEARCH_CHARS = 24000;
/**
 * Spec canvas size cap. Pre-stamped specs are typically <5KB; a
 * pathological one with 30+ entities and 50+ endpoints could hit
 * 30KB+. Truncate at 40KB (~10K tokens for a typical model) to
 * keep room for the prompt + research + reply. The Zod-validated
 * canvas on disk is the source of truth — this truncation is just
 * for prompt budgeting, not for re-parsing.
 */
const SPEC_CANVAS_CHAR_CAP = 40000;

/**
 * Draft a `ScreensCanvas` for the given venture using the active LLM
 * provider. See module docstring for the contract.
 */
export async function draftScreensCanvas(
  args: DraftScreensCanvasArgs
): Promise<ScreensDraftResult> {
  // 1. Pick provider — respects per-venture override, then global, then
  // first-usable. If nothing's configured, surface a clear error
  // pointing at the Options tab (mirror of spec-drafter wording).
  const provider = await pickActiveProvider(args.venture.id);
  if (!provider) {
    return {
      ok: false,
      error: "No LLM provider configured. Open the Options tab to add an API key.",
    };
  }
  const setting = await db.getLlmSetting(provider);
  const catalog = getProvider(provider);
  const model = setting?.model || catalog.defaultModel;

  // 2. Read inputs. Spec canvas is the primary input — without it the
  // model can only guess at the product's surface area. Brand brief
  // and research are secondary context. All three are best-effort:
  // missing inputs produce a thinner draft with a placeholder set,
  // not an error. The prompt has explicit branches for each absent.
  const specCanvasJson = await tryReadSpecCanvas(args.venture.rootPath);
  const brandBriefJson = await tryReadBrandBrief(args.venture.rootPath);
  const researchSummary = await tryReadResearchReports(
    args.venture.rootPath,
    args.manifest.appType
  );

  // 3. Build the prompt.
  const { system, user } = screensDraftPrompt({
    ventureName: args.venture.name,
    appType: args.manifest.appType,
    manifest: args.manifest,
    specCanvasJson,
    brandBriefJson,
    researchSummary,
  });

  // 4. Stream. Single user turn — drafting is one-shot, no
  // conversation history. Temperature kept low (0.3) for consistent
  // JSON shape; mirror of spec-drafter's value. maxTokens 6000 is
  // enough for ~12 screens with full notes; lower than spec-drafter's
  // 8000 because the screens canvas is structurally smaller.
  const optimizedSystem = await optimize({
    prompt: system,
    context: "wireframe",
    ventureId: args.venture.id,
  });
  console.info(
    "[prompt-master] screens-drafter",
    optimizedSystem.fallbackUsed
      ? "(fallback — transport unavailable)"
      : `tokensSaved=${optimizedSystem.tokensSaved} cacheHit=${optimizedSystem.cacheHit}`
  );
  let raw: string;
  try {
    raw = await streamChat({
      provider,
      messages: [{ role: "user", content: user }],
      system: optimizedSystem.optimized,
      maxTokens: 6000,
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

  // 5. Extract JSON. Same fence-first / greedy-bracket fallback as
  // spec-drafter.
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
      error: `Model returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 6. Stamp authoritative fields and validate. ventureId / timestamps
  // / version are NOT trusted from the model — the UI owns them. Zod
  // safeParse so any shape drift surfaces as an actionable error
  // rather than crashing the panel render.
  const now = new Date().toISOString();
  const stamped = {
    ...(parsedJson as Record<string, unknown>),
    ventureId: args.venture.id,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };

  const result = ScreensCanvasSchema.safeParse(stamped);
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
// Input loaders — all best-effort. Missing files / dirs return null
// rather than throw; the prompt has explicit branches for either case.
// ---------------------------------------------------------------------------

/**
 * Read the spec-canvas.json verbatim, with a sanity-check size cap.
 * We pass it through as raw JSON (NOT Zod-parsed) so a brief schema
 * drift doesn't break the screens drafter — the model handles loose
 * shape fine, and the spec audit already flags any genuine
 * malformation.
 */
async function tryReadSpecCanvas(ventureRoot: string): Promise<string | null> {
  const path = getSpecCanvasPath(ventureRoot);
  try {
    const exists = await invoke<boolean>("path_exists", { path });
    if (!exists) return null;
    const raw = await invoke<string>("read_file", { path });
    if (raw.length > SPEC_CANVAS_CHAR_CAP) {
      // Truncated specs are rare in practice; warn so a future
      // debug session has a breadcrumb. The draft will still
      // succeed for everything that fit; downstream founder
      // review catches the rest.
      console.warn(
        `[screens-drafter] spec canvas exceeded ${SPEC_CANVAS_CHAR_CAP} chars, truncating for prompt`
      );
      return raw.slice(0, SPEC_CANVAS_CHAR_CAP) + "\n... (truncated)";
    }
    return raw;
  } catch (err) {
    console.warn("[screens-drafter] spec canvas read failed", err);
    return null;
  }
}

/**
 * Read the brand-brief.json verbatim. Same approach as spec-drafter —
 * pass-through raw JSON so a brand-brief schema bump doesn't break
 * the drafter.
 */
async function tryReadBrandBrief(ventureRoot: string): Promise<string | null> {
  const path = `${getBrandKitDir(ventureRoot)}/brand-brief.json`;
  try {
    const exists = await invoke<boolean>("path_exists", { path });
    if (!exists) return null;
    return await invoke<string>("read_file", { path });
  } catch (err) {
    console.warn("[screens-drafter] brand brief read failed", err);
    return null;
  }
}

/**
 * Read every .md file under `01_research/<appType>/`, concatenate
 * with filename headers, and apply per-file + total truncation caps.
 * Identical logic to spec-drafter — we keep it copied (not extracted)
 * so the two drafters can evolve their input handling independently
 * without coupling.
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
        console.warn(`[screens-drafter] read failed for ${file.path}`, err);
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
            `\n[... ${remaining} additional research file${
              remaining === 1 ? "" : "s"
            } omitted to fit context ...]`
          );
        }
        break;
      }
    }
    return parts.join("\n\n---\n\n");
  } catch (err) {
    console.warn("[screens-drafter] research reports read failed", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// JSON extraction — fenced-first, then greedy-bracket fallback.
// (Identical to spec-drafter — kept inline so the two modules don't
// share a fragile contract through a third file. If we ever extract
// it, the place to put it is `apps/founder-desktop/src/lib/json-extract.ts`
// and both drafters import from there.)
// ---------------------------------------------------------------------------

/**
 * Pull the JSON canvas out of the model's reply.
 *
 * Strategy:
 *   1. Look for a fenced block (```json ... ``` or ``` ... ```). The
 *      prompt asks for this explicitly; most providers comply.
 *   2. Fall back to the substring between the first `{` and last `}`.
 *      Catches cases where the model forgot the fence but did emit a
 *      single JSON object surrounded by prose.
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
