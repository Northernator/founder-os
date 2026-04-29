/**
 * BrandChatPanel -- v0.2 of the Gemini-pinned CLI-style chat that will
 * eventually replace the concepts-grid + full-pack regions of the
 * Brand tab. This iteration adds:
 *   - /concepts (4 archetypes in parallel)
 *   - /logo <archetype> (single archetype only)
 * with the sticky refs tray flowing into every archetype prompt as
 * `@<abs-path>` tokens.
 *
 * Generation is delegated to the existing `generateLogoCandidates`
 * helper in ../../lib/brand-gen.js, which already streams archetype
 * results progressively via onArchetypeDone. We mount one chat
 * message per generation run and update its `attachments` array as
 * each archetype finishes -- so the user sees the four cards fill in
 * one by one rather than waiting for a final batch.
 *
 * SVG previews use dangerouslySetInnerHTML, mirroring the existing
 * LogoCandidateCard. brand-gen's extractSvg strips <script> tags
 * before returning, so this is the same trust boundary the existing
 * AI Logo Candidates section uses.
 *
 * Still NOT in this iteration: /iterate, /lock, /pack, /export,
 * persistence to JSONL, copying refs into <root>/03_brand/refs/.
 */
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { injectImageRefs } from "../../lib/brand-chat/refs.js";
import {
  type TypographyPairing,
  TYPOGRAPHY_CATALOG,
} from "../../lib/brand-chat/typography-catalog.js";
import {
  type BrandGenBrief,
  type LogoArchetype,
  type LogoCandidate,
  type PackAssetResult,
  FULL_PACK_SPECS,
  SYSTEM_PROMPT_SVG,
  extractSvg,
  generateFullPack,
  generateLogoCandidates,
} from "../../lib/brand-gen.js";
import { streamChat } from "../../lib/llm-client.js";
import { joinPath } from "../../lib/venture-io.js";
import { pushToast } from "../../lib/toasts.js";

/** Triage state for a generated concept card. Mirrors the name-triage
 *  UX in NameTriageList: "new" = freshly generated, "possible" = user
 *  marked it as a candidate worth keeping, "fail" = rejected, "chosen"
 *  = locked as the brand logo via /lock or the card's lock button.
 *  Persisted in JSONL via chat history; no separate state machine. */
type ConceptStatus = "new" | "possible" | "fail" | "chosen";

type ConceptAttachment = {
  /** 1-based index for display in the chat. */
  index: number;
  archetype: LogoArchetype;
  /** SVG markup once generation completes. Empty string while pending. */
  svg: string;
  error?: string;
  /** Triage state. Defaults to "new". Cards with no status render
   *  neutral; "possible"/"fail"/"chosen" tint the card border and
   *  show a status chip in the header. */
  status?: ConceptStatus;
};

/** A single typography pairing returned by /type. The catalog index is
 *  preserved for traceability but rendered with the resolved family
 *  names so future readers don't need the catalog to interpret. */
type TypeSuggestion = {
  index: number;
  heading: string;
  body: string;
  rationale: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
  /** Logo concept cards rendered as a grid below the message text. */
  attachments?: ConceptAttachment[];
  /** Brand-pack asset results (email header, social banners, brand
   *  guide, etc.) rendered as a grid below the message text. Used by
   *  /pack to show progress + previews and consumed by /export. */
  packResults?: PackAssetResult[];
  /** Typography pairings from /type. Catalog-backed so font names are
   *  guaranteed real Google Fonts families. */
  typeSuggestions?: TypeSuggestion[];
  /** 1-based run number assigned to /concepts, /logo, and /iterate
   *  carrier messages. Lets /lock and /iterate target a specific
   *  earlier run via "<runId>.<index>" instead of always picking from
   *  the latest. Pack and prose messages don't get one. */
  runId?: number;
};

const ALL_ARCHETYPES: readonly LogoArchetype[] = [
  "wordmark",
  "lettermark",
  "icon-wordmark",
  "abstract-mark",
];

/** Mirrors brand-gen's private ARCHETYPE_DESCRIPTIONS so /lock can
 *  build a LogoCandidate-shaped object for the host's onLockCandidate
 *  prop without forcing a wider export. Keep these in sync if the
 *  upstream copy changes. */
const ARCHETYPE_DESCRIPTIONS: Record<LogoArchetype, string> = {
  wordmark: "Typography-only -- name as the logo",
  lettermark: "Stylised initials as a symbol",
  "icon-wordmark": "Icon + name side by side",
  "abstract-mark": "Pure symbol, no letters",
};

/**
 * Find concept attachment [n] in the most recent message that has any.
 * `n` is the 1-based UI index the user types, e.g. /lock 2 -> n = 2.
 * Returns null if no message has attachments yet, or [n] is out of range.
 *
 * Lives at module scope so handleSlash can call it without taking
 * `messages` through a useCallback dep tangle.
 */
function pickFromLatestRun(
  messages: ChatMessage[],
  n: number
): ConceptAttachment | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.attachments && m.attachments.length > 0) {
      return m.attachments.find((a) => a.index === n) ?? null;
    }
  }
  return null;
}

/** Compute the next 1-based run number for /concepts /logo /iterate.
 *  Reads from current messages so concurrent appends stay monotonic
 *  even when multiple state updates batch into one render. */
function nextRunId(messages: readonly ChatMessage[]): number {
  let max = 0;
  for (const m of messages) {
    if (typeof m.runId === "number" && m.runId > max) max = m.runId;
  }
  return max + 1;
}

type ConceptRef = { runId: number | null; index: number };

/** Parse the <ref> argument of /lock and /iterate. Accepts either a
 *  bare 1-based index ("2", meaning index 2 of the LATEST run with
 *  attachments) or a dotted form ("3.2", meaning index 2 of run 3).
 *  Returns null on malformed input. */
function parseRef(arg: string): ConceptRef | null {
  if (!arg) return null;
  const dotted = arg.match(/^(\d+)\.(\d+)$/);
  if (dotted) {
    return {
      runId: Number.parseInt(dotted[1], 10),
      index: Number.parseInt(dotted[2], 10),
    };
  }
  if (/^\d+$/.test(arg)) {
    return { runId: null, index: Number.parseInt(arg, 10) };
  }
  return null;
}

/** Resolve a ConceptRef to a concrete attachment. ref.runId === null
 *  falls back to pickFromLatestRun for backward compat with the
 *  earlier "/lock 2" form that never had run numbers. */
function pickConcept(
  messages: readonly ChatMessage[],
  ref: ConceptRef
): ConceptAttachment | null {
  if (ref.runId === null) {
    return pickFromLatestRun(messages as ChatMessage[], ref.index);
  }
  for (const m of messages) {
    if (m.runId === ref.runId && m.attachments && m.attachments.length > 0) {
      return m.attachments.find((a) => a.index === ref.index) ?? null;
    }
  }
  return null;
}

const HELP_TEXT = [
  "Available commands:",
  "  /help                    Show this list",
  "  /style                   Add a reference image to the sticky tray",
  "  /refs                    List images currently in the tray",
  "  /refs clear              Empty the tray",
  "  /clear                   Clear the visible scrollback",
  "  /concepts                Generate 4 archetypes in parallel",
  "  /logo <archetype>        Generate one archetype only",
  `                           Options: ${ALL_ARCHETYPES.join(", ")}`,
  "  /iterate <n> <prompt>    Refine concept [n] from the latest run",
  "                           Use \"<R>.<n>\" to target an earlier run",
  "  /lock <n>                Save concept [n] as the brand logo + palette",
  "                           Use \"<R>.<n>\" to lock from an earlier run",
  "  /pack                    Generate the full brand pack (6 assets)",
  "  /export                  Write the latest pack to 03_brand/exports/",
  "  /type                    Suggest 3 Google Fonts pairings for this brand",
  "",
  "Anything else is sent as prose to Gemini with the current",
  "reference images attached as @<path> tokens.",
].join("\n");

const SYSTEM_PROMPT =
  "You are helping a founder iterate on brand identity (logos, marks, " +
  "typography, colour). When reference images are attached, treat " +
  "them as style anchors. Keep replies concise and concrete -- " +
  "describe what you would change, suggest one or two next moves, " +
  "and ask one question if direction is missing. Do not produce SVG " +
  "in chat replies; the user has dedicated commands for that.";

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function basenameOf(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

function isLogoArchetype(s: string): s is LogoArchetype {
  return (ALL_ARCHETYPES as readonly string[]).includes(s);
}

/** Subdirectory under the venture root where chat history persists. */
const CHAT_HISTORY_REL_DIR = "03_brand";
const CHAT_HISTORY_FILE = "chat.jsonl";

function chatHistoryPath(rootPath: string): string {
  return joinPath(joinPath(rootPath, CHAT_HISTORY_REL_DIR), CHAT_HISTORY_FILE);
}

/**
 * Read prior chat turns from <rootPath>/03_brand/chat.jsonl. Returns
 * an empty array if the file does not exist yet (first session) or
 * contains nothing parseable. We deliberately swallow per-line parse
 * errors so a single corrupted line cannot wipe the whole history --
 * the user can still see surviving turns and keep going.
 */
async function loadChatHistory(rootPath: string): Promise<ChatMessage[]> {
  try {
    const raw = await invoke<string>("read_file", {
      path: chatHistoryPath(rootPath),
    });
    const out: ChatMessage[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (
          parsed &&
          typeof parsed.id === "string" &&
          typeof parsed.role === "string" &&
          typeof parsed.content === "string"
        ) {
          out.push(parsed as ChatMessage);
        }
      } catch {
        // Skip malformed line; keep going.
      }
    }
    return out;
  } catch {
    // File does not exist yet -- normal on first session.
    return [];
  }
}

/**
 * Persist the current message log to <rootPath>/03_brand/chat.jsonl
 * by rewriting the whole file (one JSON object per line). For chat
 * sizes we expect (a few hundred KB tops) this is simpler than a
 * proper append protocol and means a single write-failure cannot
 * leave the file half-written.
 *
 * mkdir_p the 03_brand dir first so this works even on a fresh
 * venture that has not run any other brand-stage step yet.
 */
async function persistChatHistory(
  rootPath: string,
  messages: readonly ChatMessage[]
): Promise<void> {
  try {
    await invoke("mkdir_p", {
      path: joinPath(rootPath, CHAT_HISTORY_REL_DIR),
    });
    const jsonl = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await invoke("write_file", {
      path: chatHistoryPath(rootPath),
      content: jsonl,
    });
  } catch (err) {
    // Persistence failures should not break the running chat -- log
    // for the dev console and let the in-memory state continue.
    console.warn("[brand-chat] persistChatHistory failed", err);
  }
}

/** Auto-save a single generated concept SVG to disk. Files land in
 *  <root>/03_brand/logo/generated/run-<runId>-<archetype>.svg so each
 *  run's four candidates are individually browsable + draggable
 *  outside the app. Failures are logged but never thrown -- the chat
 *  card continues to render the SVG inline regardless. */
async function autoSaveConcept(
  rootPath: string,
  runId: number,
  archetype: string,
  svg: string
): Promise<void> {
  if (!svg || !rootPath) return;
  const dir = joinPath(
    joinPath(joinPath(rootPath, "03_brand"), "logo"),
    "generated"
  );
  try {
    await invoke("mkdir_p", { path: dir });
    const filename = `run-${runId}-${archetype}.svg`;
    await invoke("write_file", {
      path: joinPath(dir, filename),
      content: svg,
    });
  } catch (err) {
    console.warn(
      "[brand-chat] autoSaveConcept failed",
      archetype,
      err
    );
  }
}

/**
 * Parse Gemini's response to a /type prompt into TypeSuggestion[].
 * Handles bare JSON, ```json``` fences, and the occasional preamble.
 * Maps catalogIndex -> resolved heading/body names and drops any
 * out-of-range or duplicate picks defensively. Returns empty on parse
 * failure; the caller surfaces a friendly retry message.
 */
function parseTypeResponse(raw: string): TypeSuggestion[] {
  const trimmed = raw.trim();
  // Try ```json ... ``` fences first.
  let jsonText = trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (fenced) {
    jsonText = fenced[1].trim();
  } else {
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start >= 0 && end > start) {
      jsonText = trimmed.slice(start, end + 1);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<number>();
  const out: TypeSuggestion[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { catalogIndex?: unknown; rationale?: unknown };
    const idx =
      typeof rec.catalogIndex === "number" ? rec.catalogIndex : Number.NaN;
    if (!Number.isFinite(idx)) continue;
    if (idx < 1 || idx > TYPOGRAPHY_CATALOG.length) continue;
    if (seen.has(idx)) continue;
    seen.add(idx);
    const cat = TYPOGRAPHY_CATALOG[idx - 1] as TypographyPairing;
    out.push({
      index: out.length + 1,
      heading: cat.heading,
      body: cat.body,
      rationale:
        typeof rec.rationale === "string" ? rec.rationale : "",
    });
  }
  return out;
}

export function BrandChatPanel(props: {
  ventureId: string;
  /** Absolute path to the venture root. Used to read/write the
   *  `03_brand/chat.jsonl` history file so the chat survives reloads. */
  rootPath: string;
  /** Lazy accessor for the brand brief -- called on demand by /logo
   *  and /concepts so the chat panel doesn't re-render on every brief
   *  change. Returns null if the brief isn't ready yet (e.g. no name
   *  candidate chosen). */
  getBrief?: () => BrandGenBrief | null;
  /** Called when /lock <n> picks a candidate. The host writes the SVG
   *  to <root>/03_brand/logo/generated/logo-chosen.svg, splices the
   *  extracted palette into the canvas, and re-opens the brand-lock
   *  gate. Same shape as the existing AI Logo Candidates "Use this
   *  candidate" handler, so the host can pass it directly. */
  onLockCandidate?: (candidate: LogoCandidate) => void;
  /** Lazy accessor for the user's currently locked logo SVG. Returns
   *  null if nothing is locked yet. /pack uses this to seed
   *  generateFullPack with the lockedLogoSvg parameter that the asset
   *  prompts reference. Without it /pack soft-errors. */
  getLockedLogoSvg?: () => string | null;
  /** Called by /export to persist the latest /pack results to disk.
   *  The host owns path conventions (currently
   *  <root>/03_brand/exports/<spec.relPath> + exports/logo/logo.svg)
   *  so the chat panel doesn't need rootPath access. Returns a small
   *  summary the chat surfaces in a status message. */
  onExportPack?: (
    results: PackAssetResult[]
  ) => Promise<{ written: number; failed: number; targetDir: string }>;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: makeId(),
      role: "system",
      content:
        "Brand chat (gemini, v0.2). Type /help for commands. " +
        "/concepts and /logo wrap the existing brand-gen pipeline.",
      ts: Date.now(),
    },
  ]);
  const [refs, setRefs] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [showInstructions, setShowInstructions] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  // Hydrate-from-disk plumbing. `hydratedRef` flips true once we
  // finish the initial load attempt (whether it found a file or not).
  // `skipPersistRef` swallows the single re-render that fires right
  // after `setMessages(loaded)` so we don't immediately overwrite the
  // file we just read with the same content.
  const hydratedRef = useRef(false);
  const skipPersistRef = useRef(false);

  // Load prior chat history once per rootPath. Setting state from the
  // loaded turns triggers a re-render which the persist effect ignores
  // via skipPersistRef.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await loadChatHistory(props.rootPath);
      if (cancelled) return;
      if (loaded.length > 0) {
        skipPersistRef.current = true;
        setMessages(loaded);
      }
      hydratedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [props.rootPath]);

  // Persist the message log on every change, debounced. We gate on
  // `hydratedRef` so the very first render (with the seeded system
  // banner) does not blow away an existing file before we have read
  // it. We also skip the one re-render that hydration itself causes,
  // and refuse to persist a single-system-message log to avoid
  // creating an empty-feeling chat.jsonl before any real activity.
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (skipPersistRef.current) {
      skipPersistRef.current = false;
      return;
    }
    if (messages.length <= 1) return;
    const t = setTimeout(() => {
      void persistChatHistory(props.rootPath, messages);
    }, 500);
    return () => clearTimeout(t);
  }, [messages, props.rootPath]);

  // Google Fonts loader for /type results. Walks every message, dedups
  // every (heading, body) family the user has seen this session, and
  // updates a single <link> tag in document.head so the previews
  // render in their intended typeface rather than a fallback. The tag
  // sticks around for the chat panel's lifetime -- removing it on
  // unmount risked a flash-of-fallback when navigating between tabs,
  // and the cost of an idle stylesheet link is negligible.
  useEffect(() => {
    const families = new Set<string>();
    for (const m of messages) {
      if (!m.typeSuggestions) continue;
      for (const s of m.typeSuggestions) {
        families.add(s.heading);
        if (s.heading !== s.body) families.add(s.body);
      }
    }
    if (families.size === 0) return;
    const linkId = "brand-chat-google-fonts";
    let link = document.getElementById(linkId) as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.id = linkId;
      link.rel = "stylesheet";
      document.head.appendChild(link);
    }
    const param = [...families]
      .sort()
      .map((f) => `family=${f.replace(/ /g, "+")}:wght@400;700`)
      .join("&");
    link.href = `https://fonts.googleapis.com/css2?${param}&display=swap`;
  }, [messages]);

  const append = useCallback((role: ChatMessage["role"], content: string) => {
    setMessages((m) => [...m, { id: makeId(), role, content, ts: Date.now() }]);
  }, []);

  const handleStyle = useCallback(async () => {
    let selected: string | string[] | null;
    try {
      selected = await openFileDialog({
        multiple: false,
        filters: [
          {
            name: "Image",
            extensions: ["png", "jpg", "jpeg", "webp", "gif"],
          },
        ],
      });
    } catch (err) {
      pushToast({
        kind: "warn",
        message: "Could not open file picker",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!selected) return;
    const srcPath = Array.isArray(selected) ? selected[0] : selected;
    if (!srcPath) return;

    // Try to copy the picked file into <root>/03_brand/refs/ so the
    // ref survives moves of the original. If the copy_file Rust
    // command isn't registered yet (e.g. user hasn't restarted
    // `tauri dev` after this slice landed), fall back to using the
    // user's original path -- non-durable but still functional for
    // the current session.
    const filename = basenameOf(srcPath);
    const refsDir = joinPath(joinPath(props.rootPath, "03_brand"), "refs");
    const dstPath = joinPath(refsDir, `${Date.now()}-${filename}`);
    let storedPath = dstPath;
    let copied = true;
    try {
      await invoke("copy_file", { src: srcPath, dst: dstPath });
    } catch (err) {
      console.warn("[brand-chat] copy_file unavailable, using source path", err);
      storedPath = srcPath;
      copied = false;
    }

    setRefs((r) =>
      r.includes(storedPath) ? r : [...r, storedPath]
    );
    append(
      "system",
      copied
        ? `Added reference: ${basenameOf(storedPath)} (copied to 03_brand/refs/)`
        : `Added reference: ${basenameOf(storedPath)} (note: pointing at original; restart the app to get a durable copy)`
    );
  }, [append, props.rootPath]);

  const runConcepts = useCallback(
    async (only: LogoArchetype | undefined) => {
      if (running) {
        append("system", "Already running. Cancel first.");
        return;
      }
      const brief = props.getBrief?.() ?? null;
      if (
        !brief ||
        !brief.companyName ||
        brief.companyName === "Untitled brand"
      ) {
        append(
          "system",
          "No brand brief yet. Pick a name candidate and fill the Direction section first."
        );
        return;
      }

      const archs = only ? [only] : ALL_ARCHETYPES;
      const placeholders: ConceptAttachment[] = archs.map((a, i) => ({
        index: i + 1,
        archetype: a,
        svg: "",
      }));
      const headerId = makeId();
      // Capture the runId outside the setMessages updater so the
      // auto-save closures below can name files run-<rid>-<archetype>.
      let myRunId = 0;
      setMessages((m) => {
        myRunId = nextRunId(m);
        return [
          ...m,
          {
            id: headerId,
            role: "system",
            content: only
              ? `[Run ${myRunId}] Generating ${only}...`
              : `[Run ${myRunId}] Generating ${archs.length} concepts (${archs.join(", ")})...`,
            ts: Date.now(),
            attachments: placeholders,
            runId: myRunId,
          },
        ];
      });

      setRunning(true);
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        const results = await generateLogoCandidates({
          brief,
          provider: "gemini",
          ventureId: props.ventureId,
          imageRefs: refs,
          archetypes: only ? [only] : undefined,
          signal: ctrl.signal,
          onArchetypeDone: (cand) => {
            setMessages((m) =>
              m.map((msg) => {
                if (msg.id !== headerId) return msg;
                const next = (msg.attachments ?? []).map((a) =>
                  a.archetype === cand.archetype
                    ? { ...a, svg: cand.svg, error: cand.error }
                    : a
                );
                return { ...msg, attachments: next };
              })
            );
            if (cand.svg && !cand.error) {
              void autoSaveConcept(
                props.rootPath,
                myRunId,
                cand.archetype,
                cand.svg
              );
            }
          },
        });
        const okCount = results.filter((r) => r.svg && !r.error).length;
        const errCount = results.length - okCount;
        setMessages((m) =>
          m.map((msg) =>
            msg.id === headerId
              ? {
                  ...msg,
                  content: only
                    ? `[Run ${msg.runId}] Done: ${only}${errCount ? " (errored)" : ""}`
                    : `[Run ${msg.runId}] Done. ${okCount}/${results.length} concepts ready${errCount ? `, ${errCount} errored` : ""}.`,
                }
              : msg
          )
        );
      } catch (err) {
        const isAbort = err instanceof Error && err.name === "AbortError";
        if (isAbort) {
          append("system", "Cancelled.");
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          append("system", `! error: ${msg}`);
        }
      } finally {
        setRunning(false);
        abortRef.current = null;
      }
    },
    [append, props, refs, running]
  );

  const runIterate = useCallback(
    async (
      archetype: LogoArchetype,
      prevSvg: string,
      refinement: string
    ) => {
      if (running) {
        append("system", "Already running. Cancel first.");
        return;
      }
      const placeholder: ConceptAttachment = {
        index: 1,
        archetype,
        svg: "",
      };
      const headerId = makeId();
      let myRunId = 0;
      setMessages((m) => {
        myRunId = nextRunId(m);
        return [
          ...m,
          {
            id: headerId,
            role: "system",
            content: `[Run ${myRunId}] Iterating ${archetype}: "${refinement}"`,
            ts: Date.now(),
            attachments: [placeholder],
            runId: myRunId,
          },
        ];
      });

      setRunning(true);
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      // Build a refinement prompt that hands Gemini the prior SVG as
      // textual context plus the user's tweak. Refs from the sticky
      // tray ride along as @<path> tokens. We reuse SYSTEM_PROMPT_SVG
      // so the output contract (raw SVG, no fences, no preamble) is
      // identical to the per-archetype calls.
      const userContent = injectImageRefs(
        [
          `You previously generated this ${archetype} logo:`,
          "",
          prevSvg,
          "",
          `User refinement: ${refinement}`,
          "",
          `Generate a NEW ${archetype} logo. Keep what's working, change what the user asked. Output ONLY raw SVG with a viewBox attribute.`,
        ].join("\n"),
        refs
      );

      try {
        const raw = await streamChat({
          provider: "gemini",
          system: SYSTEM_PROMPT_SVG,
          messages: [{ role: "user", content: userContent }],
          temperature: 0.8,
          maxTokens: 2000,
          signal: ctrl.signal,
        });
        const svg = extractSvg(raw);
        setMessages((m) =>
          m.map((mm) => {
            if (mm.id !== headerId) return mm;
            return {
              ...mm,
              content: svg
                ? `[Run ${mm.runId}] Done. New ${archetype} ready below.`
                : `[Run ${mm.runId}] Iteration failed: model returned no valid SVG.`,
              attachments: [
                {
                  index: 1,
                  archetype,
                  svg,
                  error: svg ? undefined : "no SVG returned",
                },
              ],
            };
          })
        );
        if (svg) {
          void autoSaveConcept(props.rootPath, myRunId, archetype, svg);
        }
      } catch (err) {
        const isAbort = err instanceof Error && err.name === "AbortError";
        if (isAbort) {
          append("system", "Cancelled.");
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          append("system", `! error: ${msg}`);
        }
      } finally {
        setRunning(false);
        abortRef.current = null;
      }
    },
    [append, refs, running]
  );

  const runPack = useCallback(async () => {
    if (running) {
      append("system", "Already running. Cancel first.");
      return;
    }
    const brief = props.getBrief?.() ?? null;
    if (
      !brief ||
      !brief.companyName ||
      brief.companyName === "Untitled brand"
    ) {
      append(
        "system",
        "No brand brief yet. Pick a name and fill the Direction section first."
      );
      return;
    }
    const lockedLogo = props.getLockedLogoSvg?.() ?? null;
    if (!lockedLogo) {
      append(
        "system",
        "No logo locked yet. Run /concepts, then /lock <n> before /pack."
      );
      return;
    }

    // Seed the carrier message with one placeholder per pack spec so
    // the user sees the 6 cards immediately and watches them flip from
    // pending -> running -> done as generateFullPack streams results.
    const placeholders: PackAssetResult[] = FULL_PACK_SPECS.map((spec) => ({
      spec,
      content: "",
    }));
    const headerId = makeId();
    setMessages((m) => [
      ...m,
      {
        id: headerId,
        role: "system",
        content: `Generating brand pack (${placeholders.length} assets)...`,
        ts: Date.now(),
        packResults: placeholders,
      },
    ]);

    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const results = await generateFullPack({
        brief,
        provider: "gemini",
        lockedLogoSvg: lockedLogo,
        ventureId: props.ventureId,
        signal: ctrl.signal,
        onAssetDone: (r) => {
          setMessages((m) =>
            m.map((msg) => {
              if (msg.id !== headerId) return msg;
              const next = (msg.packResults ?? []).map((existing) =>
                existing.spec.key === r.spec.key ? r : existing
              );
              return { ...msg, packResults: next };
            })
          );
        },
      });
      const okCount = results.filter((r) => r.content && !r.error).length;
      const errCount = results.length - okCount;
      setMessages((m) =>
        m.map((msg) =>
          msg.id === headerId
            ? {
                ...msg,
                content: `Pack ready: ${okCount}/${results.length} assets generated${errCount ? `, ${errCount} errored` : ""}. Run /export to write them to disk.`,
              }
            : msg
        )
      );
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (isAbort) {
        append("system", "Cancelled.");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        append("system", `! error: ${msg}`);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [append, props, running]);

  const runType = useCallback(async () => {
    if (running) {
      append("system", "Already running. Cancel first.");
      return;
    }
    const brief = props.getBrief?.() ?? null;
    if (!brief || !brief.companyName) {
      append(
        "system",
        "No brand brief yet. Pick a name and fill the Direction section first."
      );
      return;
    }

    const headerId = makeId();
    setMessages((m) => [
      ...m,
      {
        id: headerId,
        role: "system",
        content: "Picking typography pairings...",
        ts: Date.now(),
      },
    ]);

    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Build the prompt from the catalog. We hand Gemini a numbered
    // list and ask it to return three picks as a JSON array referring
    // back to those indices. Catalog-bound output means we can map
    // the response onto known-real Google Fonts names without trusting
    // the model not to hallucinate.
    const catalogStr = TYPOGRAPHY_CATALOG.map(
      (p, i) => `${i + 1}. ${p.heading} / ${p.body} -- ${p.vibe}`
    ).join("\n");

    const userContent = injectImageRefs(
      [
        `Brand: ${brief.companyName}`,
        brief.tagline ? `Tagline: ${brief.tagline}` : null,
        brief.mission ? `Mission: ${brief.mission}` : null,
        brief.targetAudience ? `Audience: ${brief.targetAudience}` : null,
        `Personality: ${brief.personality.join(", ") || "(none)"}`,
        brief.toneOfVoice ? `Voice: ${brief.toneOfVoice}` : null,
        "",
        "Catalog of typography pairings:",
        catalogStr,
        "",
        "Pick the three pairings that best fit this brand. Return JSON only:",
        "[",
        '  {"catalogIndex": <1-based number>, "rationale": "<one sentence>"},',
        "  ...3 entries total",
        "]",
        "No prose, no markdown fences, no preamble.",
      ]
        .filter((s): s is string => s !== null)
        .join("\n"),
      refs
    );

    try {
      const raw = await streamChat({
        provider: "gemini",
        system:
          "You output ONLY valid JSON. No prose, no markdown fences, no commentary.",
        messages: [{ role: "user", content: userContent }],
        temperature: 0.3,
        maxTokens: 600,
        signal: ctrl.signal,
      });

      const suggestions = parseTypeResponse(raw);
      if (suggestions.length === 0) {
        setMessages((m) =>
          m.map((msg) =>
            msg.id === headerId
              ? {
                  ...msg,
                  content:
                    "! Couldn't parse Gemini's response as typography picks. Try /type again.",
                }
              : msg
          )
        );
        return;
      }

      setMessages((m) =>
        m.map((msg) =>
          msg.id === headerId
            ? {
                ...msg,
                content: `Typography picks (${suggestions.length}):`,
                typeSuggestions: suggestions,
              }
            : msg
        )
      );
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (isAbort) {
        append("system", "Cancelled.");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        append("system", `! error: ${msg}`);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [append, props, refs, running]);

  /** Find the most recent message that has a /pack result attached.
   *  /export uses this to know what to write. Returns null when no
   *  pack has been generated in the current session. */
  function pickLatestPack(messages: ChatMessage[]): PackAssetResult[] | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.packResults && m.packResults.length > 0) {
        return m.packResults;
      }
    }
    return null;
  }

  const handleSlash = useCallback(
    async (raw: string): Promise<boolean> => {
      const cmd = raw.trim();
      if (!cmd.startsWith("/")) return false;
      const [head, ...rest] = cmd.slice(1).split(/\s+/);
      const arg = rest.join(" ").trim();
      switch (head) {
        case "help":
          append("system", HELP_TEXT);
          return true;
        case "clear":
          setMessages([
            {
              id: makeId(),
              role: "system",
              content: "Scrollback cleared.",
              ts: Date.now(),
            },
          ]);
          return true;
        case "style":
          await handleStyle();
          return true;
        case "refs":
          if (arg === "clear") {
            setRefs([]);
            append("system", "Reference tray cleared.");
            return true;
          }
          if (refs.length === 0) {
            append(
              "system",
              "Reference tray is empty. Use /style to add one."
            );
            return true;
          }
          append(
            "system",
            "Current refs:\n" +
              refs.map((p, i) => `  [${i + 1}] ${p}`).join("\n")
          );
          return true;
        case "concepts":
          await runConcepts(undefined);
          return true;
        case "logo":
          if (!arg) {
            append(
              "system",
              `Specify an archetype: ${ALL_ARCHETYPES.join(", ")}`
            );
            return true;
          }
          if (!isLogoArchetype(arg)) {
            append(
              "system",
              `Unknown archetype: ${arg}. One of: ${ALL_ARCHETYPES.join(", ")}`
            );
            return true;
          }
          await runConcepts(arg);
          return true;
        case "lock": {
          if (!arg) {
            append(
              "system",
              "Specify which concept to lock, e.g. /lock 1 or /lock 2.3"
            );
            return true;
          }
          const ref = parseRef(arg);
          if (!ref) {
            append(
              "system",
              `/lock expects a number or "<run>.<n>", got "${arg}"`
            );
            return true;
          }
          const card = pickConcept(messages, ref);
          if (!card) {
            append(
              "system",
              ref.runId !== null
                ? `No concept [${ref.index}] in Run ${ref.runId}.`
                : `No concept [${ref.index}] in the latest run.`
            );
            return true;
          }
          if (!card.svg || card.error) {
            append(
              "system",
              `Concept [${ref.index}] has no SVG (${card.error ?? "still pending"}).`
            );
            return true;
          }
          if (!props.onLockCandidate) {
            append(
              "system",
              "Lock callback isn't wired by the host -- contact a developer."
            );
            return true;
          }
          props.onLockCandidate({
            archetype: card.archetype,
            svg: card.svg,
            description: ARCHETYPE_DESCRIPTIONS[card.archetype],
            provider: "gemini",
          });
          const runLabel =
            ref.runId !== null ? `Run ${ref.runId} ` : "";
          append(
            "system",
            `Locked ${runLabel}[${card.index}] ${card.archetype} as the brand logo. Palette + canonical SVG updated.`
          );
          return true;
        }
        case "iterate": {
          const parts = arg.split(/\s+/);
          const refStr = parts[0] ?? "";
          const refinement = parts.slice(1).join(" ").trim();
          const ref = parseRef(refStr);
          if (!ref || !refinement) {
            append(
              "system",
              "Usage: /iterate <n> <prompt>  (or <run>.<n> for older runs, e.g. /iterate 2.3 add more whitespace)"
            );
            return true;
          }
          const card = pickConcept(messages, ref);
          if (!card) {
            append(
              "system",
              ref.runId !== null
                ? `No concept [${ref.index}] in Run ${ref.runId}.`
                : `No concept [${ref.index}] in the latest run.`
            );
            return true;
          }
          if (!card.svg || card.error) {
            append(
              "system",
              `Concept [${ref.index}] has no SVG to iterate (${card.error ?? "still pending"}).`
            );
            return true;
          }
          await runIterate(card.archetype, card.svg, refinement);
          return true;
        }
        case "pack":
          await runPack();
          return true;
        case "export": {
          const pack = pickLatestPack(messages);
          if (!pack) {
            append(
              "system",
              "No pack to export. Run /pack first."
            );
            return true;
          }
          const writable = pack.filter((r) => r.content && !r.error);
          if (writable.length === 0) {
            append(
              "system",
              "Latest pack has nothing to write -- every asset errored. Run /pack again."
            );
            return true;
          }
          if (!props.onExportPack) {
            append(
              "system",
              "Export callback isn't wired by the host -- contact a developer."
            );
            return true;
          }
          try {
            const summary = await props.onExportPack(pack);
            const target = summary.targetDir
              ? ` to ${summary.targetDir}`
              : "";
            append(
              "system",
              `Wrote ${summary.written} asset${summary.written === 1 ? "" : "s"}${target}${summary.failed ? `, ${summary.failed} failed` : ""}.`
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            append("system", `! export failed: ${msg}`);
          }
          return true;
        }
        case "type":
          await runType();
          return true;
        default:
          append(
            "system",
            `Unknown command: /${head}. Type /help for the list.`
          );
          return true;
      }
    },
    [append, handleStyle, messages, props, refs, runConcepts, runIterate, runPack, runType]
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || running) return;
    setInput("");

    if (await handleSlash(text)) return;

    append("user", text);
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const userTurn = injectImageRefs(text, refs);
    const assistantId = makeId();
    setMessages((m) => [
      ...m,
      { id: assistantId, role: "assistant", content: "", ts: Date.now() },
    ]);

    try {
      await streamChat({
        provider: "gemini",
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userTurn }],
        temperature: 0.7,
        maxTokens: 1200,
        signal: ctrl.signal,
        onDelta: (delta) => {
          setMessages((m) =>
            m.map((msg) =>
              msg.id === assistantId
                ? { ...msg, content: msg.content + delta }
                : msg
            )
          );
        },
      });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (!isAbort) {
        const msg = err instanceof Error ? err.message : String(err);
        append("system", `! error: ${msg}`);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [append, handleSlash, input, refs, running]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /** Update one concept attachment's status flag in place. Used by the
   *  per-card Possible / Fail buttons. Status persists via JSONL since
   *  it's part of the message attachments array. */
  const setConceptStatus = useCallback(
    (
      messageId: string,
      archetype: LogoArchetype,
      status: ConceptStatus
    ) => {
      setMessages((m) =>
        m.map((msg) => {
          if (msg.id !== messageId || !msg.attachments) return msg;
          return {
            ...msg,
            attachments: msg.attachments.map((a) =>
              a.archetype === archetype ? { ...a, status } : a
            ),
          };
        })
      );
    },
    []
  );

  /** Hard-remove a concept attachment from a message. The card's `x`
   *  button calls this. Doesn't delete the on-disk SVG -- the file
   *  stays under 03_brand/logo/generated/ for manual recovery. */
  const deleteConcept = useCallback(
    (messageId: string, archetype: LogoArchetype) => {
      setMessages((m) =>
        m.map((msg) => {
          if (msg.id !== messageId || !msg.attachments) return msg;
          return {
            ...msg,
            attachments: msg.attachments.filter(
              (a) => a.archetype !== archetype
            ),
          };
        })
      );
    },
    []
  );

  /** Lock a single concept via the host's onLockCandidate prop (same
   *  function /lock <n> calls). Tags the card status as "chosen" so the
   *  border tint reflects it without requiring a re-fetch. */
  const handleLockConcept = useCallback(
    (messageId: string, a: ConceptAttachment) => {
      if (!a.svg || a.error) {
        append("system", `Cannot lock [${a.index}] -- no SVG yet.`);
        return;
      }
      if (!props.onLockCandidate) {
        append(
          "system",
          "Lock callback isn't wired by the host -- contact a developer."
        );
        return;
      }
      props.onLockCandidate({
        archetype: a.archetype,
        svg: a.svg,
        description: ARCHETYPE_DESCRIPTIONS[a.archetype],
        provider: "gemini",
      });
      setConceptStatus(messageId, a.archetype, "chosen");
      append(
        "system",
        `Locked ${a.archetype} as the brand logo. Palette + canonical SVG updated.`
      );
    },
    [append, props, setConceptStatus]
  );

  return (
    <div
      style={{
        background: "var(--bg-panel-strong, #0d0f12)",
        borderRadius: 6,
        padding: 10,
        marginTop: 8,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: 13,
        color: "var(--text-primary)",
        minHeight: 360,
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
        <span
          style={{
            fontSize: 11,
            color: "var(--text-tertiary)",
            letterSpacing: 1,
          }}
        >
          gemini, v0.2
        </span>
        <button
          type="button"
          onClick={() => setShowInstructions((s) => !s)}
          title={showInstructions ? "Hide quick start" : "Show quick start"}
          style={{
            background: "transparent",
            border: "1px solid var(--border-subtle)",
            color: "var(--text-tertiary)",
            borderRadius: 3,
            padding: "2px 8px",
            fontFamily: "inherit",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          {showInstructions ? "hide quick start" : "show quick start"}
        </button>
      </div>

      {showInstructions && (
        <div
          style={{
            background: "var(--bg-page, #07080a)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 4,
            padding: "10px 12px",
            fontSize: 12,
            lineHeight: 1.55,
            color: "var(--text-secondary, #c0c4cc)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
            Quick start
          </div>
          <ol
            style={{
              margin: 0,
              paddingLeft: 18,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <li>
              <strong>Drop in reference logos.</strong> Type{" "}
              <code style={inlineCmdStyle}>/style</code> to open a file picker
              and pick a logo or image you like the look of. It shows up above
              the input as a "ref" and is reused for every generation.
            </li>
            <li>
              <strong>Generate logo concepts.</strong>{" "}
              <code style={inlineCmdStyle}>/concepts</code> spins up four
              different styles in parallel.{" "}
              <code style={inlineCmdStyle}>/logo wordmark</code> generates one
              specific style (options: wordmark, lettermark, icon-wordmark,
              abstract-mark).
            </li>
            <li>
              <strong>Need a brand brief first?</strong> Pick a name in
              section 1 (Name) and fill out section 2 (Brand Direction). If
              anything's missing, the chat will let you know politely instead
              of running.
            </li>
            <li>
              <strong>Style with references.</strong> Drop a ref with{" "}
              <code style={inlineCmdStyle}>/style</code> first, then run{" "}
              <code style={inlineCmdStyle}>/concepts</code> -- Gemini uses your
              uploaded image as a style anchor for the new logos.
            </li>
            <li>
              <strong>Refine and pick.</strong> Once you have concepts, type{" "}
              <code style={inlineCmdStyle}>/iterate 2 make the lettering bolder</code>
              {" "}to tweak [2] from the latest run. Going back to an earlier
              run? Use <code style={inlineCmdStyle}>/iterate 1.3 ...</code>
              {" "}(run 1, concept 3). Happy with one?{" "}
              <code style={inlineCmdStyle}>/lock 2</code> (or{" "}
              <code style={inlineCmdStyle}>/lock 1.3</code>) saves it as the
              official brand logo and patches the palette automatically.
            </li>
            <li>
              <strong>Generate the full brand pack.</strong> Once a logo is
              locked, <code style={inlineCmdStyle}>/pack</code> spins up six
              polished assets in parallel (email header, X/LinkedIn banners,
              OG image, brand guide). Review them in chat, then{" "}
              <code style={inlineCmdStyle}>/export</code> writes everything to{" "}
              <code style={inlineCmdStyle}>03_brand/exports/</code>.
            </li>
            <li>
              <strong>Just chat normally.</strong> Anything that doesn't start
              with <code style={inlineCmdStyle}>/</code> is sent to Gemini as a
              regular message, with your refs riding along automatically.
            </li>
          </ol>
          <div style={{ color: "var(--text-tertiary)", fontSize: 11 }}>
            Type <code style={inlineCmdStyle}>/help</code> any time for the
            full command list.
          </div>
        </div>
      )}

      <div
        style={{
          flex: 1,
          minHeight: 220,
          maxHeight: 520,
          overflowY: "auto",
          padding: "6px 8px",
          background: "var(--bg-page, #07080a)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 4,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {messages.map((m) => (
          <div key={m.id} style={{ marginBottom: 8 }}>
            <span style={{ color: rolePrefixColor(m.role), fontWeight: 600 }}>
              {rolePrefix(m.role)}
            </span>
            <span
              style={{
                color:
                  m.role === "system"
                    ? "var(--text-tertiary)"
                    : "var(--text-primary)",
              }}
            >
              {m.content}
            </span>
            {m.attachments && m.attachments.length > 0 && (
              <div
                style={{
                  marginTop: 6,
                  display: "grid",
                  gridTemplateColumns:
                    m.attachments.length === 1
                      ? "1fr"
                      : "repeat(2, minmax(0, 1fr))",
                  gap: 6,
                }}
              >
                {m.attachments.map((a) => (
                  <ConceptCard
                    key={a.archetype}
                    a={a}
                    onPossible={() =>
                      setConceptStatus(
                        m.id,
                        a.archetype,
                        a.status === "possible" ? "new" : "possible"
                      )
                    }
                    onFail={() =>
                      setConceptStatus(
                        m.id,
                        a.archetype,
                        a.status === "fail" ? "new" : "fail"
                      )
                    }
                    onLock={() => handleLockConcept(m.id, a)}
                    onDelete={() => deleteConcept(m.id, a.archetype)}
                  />
                ))}
              </div>
            )}
            {m.packResults && m.packResults.length > 0 && (
              <div
                style={{
                  marginTop: 6,
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: 6,
                }}
              >
                {m.packResults.map((r) => (
                  <PackResultCard key={r.spec.key} r={r} />
                ))}
              </div>
            )}
            {m.typeSuggestions && m.typeSuggestions.length > 0 && (
              <div
                style={{
                  marginTop: 6,
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {m.typeSuggestions.map((s) => (
                  <TypeSuggestionCard
                    key={s.index}
                    s={s}
                    sampleHeading={
                      props.getBrief?.()?.companyName || "Your brand"
                    }
                    sampleBody={
                      props.getBrief?.()?.tagline ||
                      "Body copy sets the tone for everything beyond the headline."
                    }
                  />
                ))}
              </div>
            )}
          </div>
        ))}
        {running && (
          <div style={{ color: "var(--text-tertiary)" }}>... streaming</div>
        )}
      </div>

      {refs.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            padding: "4px 6px",
            background: "var(--bg-page, #07080a)",
            border: "1px dashed var(--border-subtle)",
            borderRadius: 4,
            fontSize: 11,
          }}
        >
          <span style={{ color: "var(--text-tertiary)" }}>refs:</span>
          {refs.map((p, i) => (
            <span
              key={p}
              title={p}
              style={{
                padding: "2px 6px",
                background: "var(--bg-panel)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 3,
              }}
            >
              [{i + 1}] {basenameOf(p)}
            </span>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span
          style={{
            color: "var(--accent, #8ab4ff)",
            fontWeight: 700,
          }}
        >
          gemini &gt;
        </span>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder="type a message or /help"
          disabled={running}
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            color: "inherit",
            fontFamily: "inherit",
            fontSize: "inherit",
          }}
        />
        {running ? (
          <button
            type="button"
            onClick={handleCancel}
            style={panelButtonStyle("var(--danger, #d97757)")}
          >
            cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={!input.trim()}
            style={panelButtonStyle("var(--accent, #8ab4ff)")}
          >
            send
          </button>
        )}
      </div>
    </div>
  );
}

function ConceptCard({
  a,
  onPossible,
  onFail,
  onLock,
  onDelete,
}: {
  a: ConceptAttachment;
  onPossible: () => void;
  onFail: () => void;
  onLock: () => void;
  onDelete: () => void;
}) {
  const status = a.status ?? "new";
  // Accent the card border by status so users can scan the grid for
  // their picks without reading text. Mirrors the name-triage UX in
  // NameTriageList where each candidate card carries a status colour.
  const borderColor =
    status === "possible"
      ? "var(--success, #6fcf97)"
      : status === "fail"
        ? "var(--danger, #d97757)"
        : status === "chosen"
          ? "var(--accent, #8ab4ff)"
          : "var(--border-subtle)";
  const ready = !!a.svg && !a.error;
  return (
    <div
      style={{
        background: "var(--bg-panel)",
        border: `1px solid ${borderColor}`,
        borderRadius: 4,
        padding: 8,
        fontSize: 11,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        opacity: status === "fail" ? 0.55 : 1,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
        }}
      >
        <span style={{ color: "var(--text-tertiary)" }}>
          [{a.index}] {a.archetype}
        </span>
        {status !== "new" && (
          <span
            style={{
              padding: "1px 6px",
              borderRadius: 3,
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: 0.4,
              textTransform: "uppercase",
              background: borderColor,
              color: "var(--bg-page, #07080a)",
            }}
          >
            {status}
          </span>
        )}
      </div>
      {a.error ? (
        <div style={{ color: "var(--danger, #d97757)" }}>! {a.error}</div>
      ) : a.svg ? (
        <div
          style={{
            background: "var(--bg-page, #07080a)",
            padding: 8,
            borderRadius: 3,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            minHeight: 80,
          }}
          // The SVG comes from brand-gen's extractSvg, which strips
          // <script> tags before returning. Same trust boundary as
          // the legacy LogoCandidateCard component had.
          dangerouslySetInnerHTML={{ __html: a.svg }}
        />
      ) : (
        <div style={{ color: "var(--text-tertiary)" }}>... generating</div>
      )}
      <div
        style={{
          display: "flex",
          gap: 4,
          marginTop: 2,
        }}
      >
        <ActionChip
          label="possible"
          onClick={onPossible}
          color="var(--success, #6fcf97)"
          active={status === "possible"}
          disabled={!ready}
        />
        <ActionChip
          label="fail"
          onClick={onFail}
          color="var(--danger, #d97757)"
          active={status === "fail"}
          disabled={!ready}
        />
        <ActionChip
          label="lock"
          onClick={onLock}
          color="var(--accent, #8ab4ff)"
          active={status === "chosen"}
          disabled={!ready}
        />
        <div style={{ flex: 1 }} />
        <ActionChip label="x" onClick={onDelete} color="var(--text-tertiary)" />
      </div>
    </div>
  );
}

/** Small text-style button used for per-card concept actions. */
function ActionChip({
  label,
  onClick,
  color,
  active,
  disabled,
}: {
  label: string;
  onClick: () => void;
  color: string;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        background: active ? color : "transparent",
        color: active ? "var(--bg-page, #07080a)" : color,
        border: `1px solid ${color}`,
        borderRadius: 3,
        padding: "2px 7px",
        fontFamily: "inherit",
        fontSize: 10,
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        textTransform: "lowercase",
        letterSpacing: 0.2,
      }}
    >
      {label}
    </button>
  );
}

function PackResultCard({ r }: { r: PackAssetResult }) {
  const { spec, content, error } = r;
  const sizeBytes = content?.length ?? 0;
  return (
    <div
      style={{
        background: "var(--bg-panel)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 4,
        padding: 8,
        fontSize: 11,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ color: "var(--text-tertiary)" }}>
        [{spec.key}] {spec.title}
      </div>
      {error ? (
        <div style={{ color: "var(--danger, #d97757)" }}>! {error}</div>
      ) : !content ? (
        <div style={{ color: "var(--text-tertiary)" }}>... generating</div>
      ) : spec.kind === "svg" ? (
        <div
          style={{
            background: "var(--bg-page, #07080a)",
            padding: 8,
            borderRadius: 3,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            minHeight: 60,
            maxHeight: 120,
            overflow: "hidden",
          }}
          // SVG comes from extractSvg upstream which strips <script>.
          dangerouslySetInnerHTML={{ __html: content }}
        />
      ) : (
        <pre
          style={{
            margin: 0,
            background: "var(--bg-page, #07080a)",
            padding: 6,
            borderRadius: 3,
            fontSize: 10,
            lineHeight: 1.4,
            maxHeight: 80,
            overflow: "hidden",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "var(--text-secondary, #c0c4cc)",
          }}
        >
          {content.slice(0, 220)}
          {content.length > 220 ? "..." : ""}
        </pre>
      )}
      <div
        style={{
          color: "var(--text-tertiary)",
          fontSize: 10,
          opacity: 0.75,
        }}
      >
        {spec.relPath} -- {sizeBytes ? `${sizeBytes} chars` : "pending"}
      </div>
    </div>
  );
}

function TypeSuggestionCard({
  s,
  sampleHeading,
  sampleBody,
}: {
  s: TypeSuggestion;
  sampleHeading: string;
  sampleBody: string;
}) {
  return (
    <div
      style={{
        background: "var(--bg-panel)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 4,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ color: "var(--text-tertiary)", fontSize: 11 }}>
        [{s.index}] {s.heading}
        {s.heading === s.body ? " (single family)" : ` / ${s.body}`}
      </div>
      <div
        style={{
          fontFamily: `'${s.heading}', system-ui, sans-serif`,
          fontWeight: 700,
          fontSize: 22,
          lineHeight: 1.1,
          color: "var(--text-primary)",
        }}
      >
        {sampleHeading}
      </div>
      <div
        style={{
          fontFamily: `'${s.body}', system-ui, sans-serif`,
          fontWeight: 400,
          fontSize: 13,
          lineHeight: 1.45,
          color: "var(--text-primary)",
        }}
      >
        {sampleBody}
      </div>
      {s.rationale && (
        <div
          style={{
            color: "var(--text-tertiary)",
            fontSize: 11,
            fontStyle: "italic",
          }}
        >
          {s.rationale}
        </div>
      )}
    </div>
  );
}

function rolePrefix(role: ChatMessage["role"]): string {
  switch (role) {
    case "user":
      return "> ";
    case "assistant":
      return "< ";
    case "system":
      return "# ";
  }
}

function rolePrefixColor(role: ChatMessage["role"]): string {
  switch (role) {
    case "user":
      return "var(--accent, #8ab4ff)";
    case "assistant":
      return "var(--success, #6fcf97)";
    case "system":
      return "var(--text-tertiary)";
  }
}

function panelButtonStyle(color: string): React.CSSProperties {
  return {
    background: "transparent",
    color,
    border: `1px solid ${color}`,
    borderRadius: 3,
    padding: "3px 10px",
    fontFamily: "inherit",
    fontSize: 12,
    cursor: "pointer",
  };
}

const inlineCmdStyle: React.CSSProperties = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontSize: 11,
  background: "var(--bg-panel-strong, #0d0f12)",
  border: "1px solid var(--border-subtle)",
  borderRadius: 3,
  padding: "1px 5px",
  color: "var(--accent, #8ab4ff)",
};
