/**
 * <SocialActions> -- reusable widget per SOCIAL-MODULE-SPEC sec 8.3.
 *
 * Mounted in MediaTab (next to render controls, pre-filled with the launch
 * reel + announcement) and AuditTab (next to the LAUNCH stage, pre-filled
 * with the launch-announcement.md text). Single source of truth for the
 * "post a video to socials" affordance -- any other tab that grows a use
 * case mounts the same component with its own prefill.
 *
 * What it renders:
 *   - 5-state backend pill        (not-configured / available / posting /
 *                                  posted-ok / posted-error)
 *   - "Compose post" button       opens an in-place modal with a
 *                                  SocialPost form (text + platforms +
 *                                  media path list)
 *   - "Open posts log" link       fires social_open_post_log; lands the
 *                                  user in 13_social/posts/ in Finder /
 *                                  Explorer / xdg-open
 *
 * What it does NOT render (per spec sec 8.1 / 8.2):
 *   - Login state per platform: that's a separate concern -- the spec
 *     section 9.1 sketch shows a dedicated panel that lives in a future
 *     SettingsTab. For round 3, the widget surfaces login state INSIDE
 *     the modal so the user sees it at compose time without forcing a
 *     full SettingsTab rebuild.
 *
 * Backend selection: defaults to "social-poster" per spec sec 3
 * (SOCIAL_DEFAULT_BACKEND-equivalent). The host tab can override via the
 * `backend` prop -- in the future this will read from
 * VentureManifest.social.backend once that lands in domain.
 */
import {
  SOCIAL_DEFAULT_PLATFORMS,
  SOCIAL_PLATFORM_CAPTION_CAPS,
  SocialPlatformSchema,
  type SocialAvailability,
  type SocialBackend,
  type SocialMediaRef,
  type SocialPerPlatformOverride,
  type SocialPlatform,
  type SocialPost,
  type SocialResult,
} from "@founder-os/social-core";
import type { VentureManifest } from "@founder-os/domain";
import { useEffect, useMemo, useState } from "react";
import {
  openSocialPostLog,
  probeSocialBackend,
  runSocialPost,
  socialLoginState,
  type SocialAdapterOpts,
  type SocialLoginStateResult,
} from "../../lib/run-social-post.js";
import { pushToast } from "../../lib/toasts.js";
import {
  generateSocialCaption,
  NoLlmProviderAvailableError,
} from "../../lib/social-caption-llm.js";
import { PostizConfigModal } from "./PostizConfigModal.js";

// ---------------------------------------------------------------------------
// Props + pill states
// ---------------------------------------------------------------------------

export type SocialActionsPrefill = {
  /**
   * Caption draft. Per spec sec 8.1 MediaTab feeds this from the first
   * ~200 chars of 08_launch/launch-announcement.md; AuditTab feeds it
   * from the same file at full length.
   */
  text?: string;
  /**
   * Pre-attached media. MediaTab attaches 10_media/render/launch-reel.mp4
   * via a single SocialMediaRef with kind: "video". AuditTab leaves this
   * empty (announcement-only) unless the user adds a thumbnail.
   */
  media?: ReadonlyArray<SocialMediaRef>;
  /**
   * Platform subset. Falls back to SOCIAL_DEFAULT_PLATFORMS when empty
   * (x / linkedin / bluesky per social-core).
   */
  platforms?: ReadonlyArray<SocialPlatform>;
};

export type SocialActionsProps = {
  ventureRoot: string;
  ventureSlug: string;
  /** Defaults to "social-poster" per spec sec 3. */
  backend?: SocialBackend;
  /** Forwarded to the Node CLI via the Tauri command. */
  adapterOpts?: SocialAdapterOpts;
  prefill?: SocialActionsPrefill;
  /**
   * Compact mode renders just the pill + a single "Post" button. Used
   * when the host tab is already busy (LaunchTab next to a checklist) and
   * doesn't have room for the full pill + button + link cluster.
   */
  compact?: boolean;
  /**
   * The venture's parsed manifest. When provided the widget will:
   *   - read manifest.social.postiz for adapter overrides (Postiz baseUrl /
   *     apiKeyEnvVar / allowRemoteOnly) when those aren't passed via
   *     adapterOpts;
   *   - mount <PostizConfigModal> so the founder can set the Postiz config
   *     without leaving the modal.
   * Omitting this disables the config picker but everything else still
   * works -- legacy hosts that haven't been updated keep functioning.
   */
  manifest?: VentureManifest | null;
  /**
   * Callback fired after the Postiz config picker writes a new manifest.
   * The host tab usually forwards this to its parent VentureDashboard so
   * the in-memory manifest stays in sync with venture.yaml.
   */
  onManifestUpdate?: (next: VentureManifest) => void;
};

/**
 * 5-state pill machine -- matches HfPill in MediaTab for visual parity.
 *
 *   not-configured  backend's available() returned false; tooltip shows reason
 *   available       backend probed successfully; ready to post
 *   posting         a post() invocation is in flight
 *   posted-ok       last post returned with every row success=true
 *   posted-error    last post returned with at least one failed row
 */
type PillState =
  | { kind: "probing" }
  | { kind: "not-configured"; reason?: string }
  | { kind: "available" }
  | { kind: "posting" }
  | { kind: "posted-ok"; successful: number; total: number }
  | { kind: "posted-error"; successful: number; total: number; firstError?: string };

const ALL_PLATFORMS = SocialPlatformSchema.options;

/**
 * Put `sp login <platform>` on the clipboard. Used by the per-row "Copy
 * login" button in the compose modal so the founder never has to retype
 * the command. Surfaces a toast so the user knows the copy landed --
 * navigator.clipboard.writeText is silent on success.
 *
 * Falls back gracefully if the clipboard API is blocked (Tauri-without-
 * clipboard-allowlist, or a sandboxed test environment) by showing the
 * command in the toast so the user can copy it manually.
 */
async function copyLoginCommand(platform: SocialPlatform): Promise<void> {
  const cmd = `sp login ${platform}`;
  try {
    await navigator.clipboard.writeText(cmd);
    pushToast({
      kind: "info",
      message: `Copied: ${cmd}`,
      ttlMs: 4000,
    });
  } catch {
    pushToast({
      kind: "warn",
      message: `Clipboard blocked. Run this in your terminal: ${cmd}`,
      ttlMs: 8000,
    });
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SocialActions(props: SocialActionsProps) {
  const backend: SocialBackend = props.backend ?? "social-poster";
  const [pill, setPill] = useState<PillState>({ kind: "probing" });
  const [modalOpen, setModalOpen] = useState(false);
  const [postizConfigOpen, setPostizConfigOpen] = useState(false);

  // Merge adapterOpts with manifest-derived defaults. Explicit props win;
  // manifest values fill in the rest. This is what lets the Postiz picker
  // persist config without callers having to thread adapterOpts through
  // the host tab on every render.
  const manifestPostiz = props.manifest?.social?.postiz;
  const effectiveAdapterOpts = useMemo<SocialAdapterOpts | undefined>(() => {
    const explicit = props.adapterOpts;
    const merged: SocialAdapterOpts = {
      spBinary: explicit?.spBinary,
      postizBaseUrl: explicit?.postizBaseUrl ?? manifestPostiz?.baseUrl,
      postizApiKeyEnv:
        explicit?.postizApiKeyEnv ?? manifestPostiz?.apiKeyEnvVar,
      postizAllowRemoteOnly:
        explicit?.postizAllowRemoteOnly ?? manifestPostiz?.allowRemoteOnly,
    };
    // Drop undefined keys so the helper's "omitted = default" semantics
    // still apply (a stray undefined would still produce a snake_case
    // entry that the Rust side might misread).
    const out: SocialAdapterOpts = {};
    for (const [k, v] of Object.entries(merged)) {
      if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }, [props.adapterOpts, manifestPostiz]);

  // Initial probe + re-probe whenever backend / effective opts change.
  // Failures fold into the pill; we never throw out of an effect.
  // biome-ignore lint/correctness/useExhaustiveDependencies: probe deps captured below
  useEffect(() => {
    let cancelled = false;
    setPill({ kind: "probing" });
    probeSocialBackend(backend, effectiveAdapterOpts)
      .then((r) => {
        if (cancelled) return;
        if (r.availability.available) {
          setPill({ kind: "available" });
        } else {
          setPill({ kind: "not-configured", reason: r.availability.reason });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPill({
          kind: "not-configured",
          reason: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [backend, effectiveAdapterOpts]);

  const handleOpenModal = () => {
    if (pill.kind === "posting") return;
    setModalOpen(true);
  };

  const handleOpenLog = async () => {
    try {
      await openSocialPostLog(props.ventureRoot);
    } catch (err) {
      pushToast({
        kind: "warn",
        message: `Could not open posts log: ${err instanceof Error ? err.message : String(err)}`,
        ttlMs: 5000,
      });
    }
  };

  const handlePosted = (result: SocialResult) => {
    const total = result.rows.length;
    const successful = result.rows.filter((r) => r.success).length;
    if (successful === total && total > 0) {
      setPill({ kind: "posted-ok", successful, total });
      pushToast({
        kind: "info",
        message: `Posted to ${successful}/${total} platforms.`,
        ttlMs: 6000,
      });
    } else {
      const firstError = result.rows.find((r) => !r.success)?.error;
      setPill({
        kind: "posted-error",
        successful,
        total,
        firstError,
      });
      pushToast({
        kind: "warn",
        message:
          successful === 0
            ? `Post failed on every platform${firstError ? `: ${firstError}` : ""}`
            : `Posted ${successful}/${total}; some platforms failed.`,
        ttlMs: 8000,
      });
    }
    setModalOpen(false);
  };

  return (
    <div
      style={{
        padding: props.compact ? 10 : 14,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        gap: props.compact ? 6 : 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <BackendPill backend={backend} state={pill} />
        <div style={{ display: "flex", gap: 8 }}>
          {backend === "postiz" && props.manifest && (
            <button
              type="button"
              onClick={() => setPostizConfigOpen(true)}
              disabled={pill.kind === "posting"}
              title="Set Postiz base URL + API key env var"
              style={{
                padding: "6px 10px",
                background: "transparent",
                border: "1px solid var(--border-subtle)",
                color: "var(--text-secondary)",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                cursor: pill.kind === "posting" ? "default" : "pointer",
              }}
            >
              {manifestPostiz?.baseUrl ? "Edit Postiz config" : "Configure Postiz"}
            </button>
          )}
          <button
            type="button"
            onClick={handleOpenModal}
            disabled={pill.kind === "posting"}
            style={{
              padding: "6px 12px",
              background:
                pill.kind === "posting" ? "var(--bg-elevated)" : "var(--accent-soft)",
              border: `1px solid ${pill.kind === "posting" ? "var(--border-subtle)" : "var(--accent-soft)"}`,
              color:
                pill.kind === "posting" ? "var(--text-muted)" : "var(--accent-hover)",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              cursor: pill.kind === "posting" ? "default" : "pointer",
            }}
          >
            {pill.kind === "posting" ? "Posting..." : "Compose post"}
          </button>
          {!props.compact && (
            <button
              type="button"
              onClick={handleOpenLog}
              style={{
                padding: "6px 12px",
                background: "transparent",
                border: "1px solid var(--border-subtle)",
                color: "var(--text-secondary)",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
              title="Open 13_social/posts/ in your file manager"
            >
              Open posts log
            </button>
          )}
        </div>
      </div>

      {modalOpen && (
        <ComposeModal
          backend={backend}
          ventureSlug={props.ventureSlug}
          ventureRoot={props.ventureRoot}
          prefill={props.prefill}
          adapterOpts={effectiveAdapterOpts}
          onCancel={() => setModalOpen(false)}
          onPosting={() => setPill({ kind: "posting" })}
          onPosted={handlePosted}
          onError={(err) => {
            setPill({
              kind: "posted-error",
              successful: 0,
              total: 0,
              firstError: err,
            });
          }}
        />
      )}
      {postizConfigOpen && props.manifest && (
        <PostizConfigModal
          ventureRoot={props.ventureRoot}
          manifest={props.manifest}
          initial={manifestPostiz}
          onClose={() => setPostizConfigOpen(false)}
          onSaved={(next) => {
            setPostizConfigOpen(false);
            props.onManifestUpdate?.(next);
            // Force a re-probe with the new config -- the pill should flip
            // to "ready" once Postiz is reachable.
            setPill({ kind: "probing" });
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pill
// ---------------------------------------------------------------------------

function BackendPill({
  backend,
  state,
}: {
  backend: SocialBackend;
  state: PillState;
}) {
  const label = pillLabel(backend, state);
  const tone = pillTone(state);
  const tooltip = pillTooltip(backend, state);
  return (
    <span
      title={tooltip}
      style={{
        padding: "4px 10px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: tone.bg,
        color: tone.fg,
        border: `1px solid ${tone.border}`,
        alignSelf: "flex-start",
      }}
    >
      {label}
    </span>
  );
}

function pillLabel(backend: SocialBackend, state: PillState): string {
  const prefix = backend === "social-poster" ? "social-poster" : backend;
  switch (state.kind) {
    case "probing":
      return `${prefix}: probing...`;
    case "not-configured":
      return `${prefix}: not configured`;
    case "available":
      return `${prefix}: ready`;
    case "posting":
      return `${prefix}: posting...`;
    case "posted-ok":
      return `${prefix}: posted ${state.successful}/${state.total}`;
    case "posted-error":
      return `${prefix}: posted ${state.successful}/${state.total} (errors)`;
  }
}

function pillTone(state: PillState): {
  bg: string;
  fg: string;
  border: string;
} {
  switch (state.kind) {
    case "probing":
    case "not-configured":
      return {
        bg: "var(--bg-elevated)",
        fg: "var(--text-muted)",
        border: "var(--border-subtle)",
      };
    case "available":
    case "posted-ok":
      return {
        bg: "var(--accent-soft)",
        fg: "var(--accent-hover)",
        border: "var(--accent-soft)",
      };
    case "posting":
      return {
        bg: "var(--bg-elevated)",
        fg: "var(--accent-hover)",
        border: "var(--accent-soft)",
      };
    case "posted-error":
      return {
        bg: "var(--bg-elevated)",
        fg: "var(--text-secondary)",
        border: "var(--border-subtle)",
      };
  }
}

function pillTooltip(backend: SocialBackend, state: PillState): string | undefined {
  if (state.kind === "not-configured") {
    if (backend === "social-poster") {
      return (
        state.reason ??
        "sp CLI not found. Install with `npm install -g @profullstack/social-poster`, then `sp login <platform>` per platform."
      );
    }
    return state.reason ?? "Backend not configured.";
  }
  if (state.kind === "posted-error" && state.firstError) {
    return state.firstError;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Compose modal
// ---------------------------------------------------------------------------

type ComposeModalProps = {
  backend: SocialBackend;
  ventureSlug: string;
  ventureRoot: string;
  prefill?: SocialActionsPrefill;
  adapterOpts?: SocialAdapterOpts;
  onCancel: () => void;
  onPosting: () => void;
  onPosted: (result: SocialResult) => void;
  onError: (msg: string) => void;
};

function ComposeModal(props: ComposeModalProps) {
  const [text, setText] = useState<string>(props.prefill?.text ?? "");
  const initialPlatforms = useMemo<SocialPlatform[]>(
    () => [...(props.prefill?.platforms ?? SOCIAL_DEFAULT_PLATFORMS)],
    [props.prefill?.platforms],
  );
  const [platforms, setPlatforms] = useState<SocialPlatform[]>(initialPlatforms);
  const media = useMemo<ReadonlyArray<SocialMediaRef>>(
    () => props.prefill?.media ?? [],
    [props.prefill?.media],
  );
  const [submitting, setSubmitting] = useState(false);
  const [loginState, setLoginState] = useState<SocialLoginStateResult | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  /**
   * Per-platform caption + hashtag overrides. Keyed by SocialPlatform. A
   * platform absent from this record uses the base `text` field; a
   * platform present with empty text but populated hashtags uses base
   * text + those hashtags. Mirrors SocialPost.perPlatformOverrides
   * exactly so the adapter can pick this up verbatim.
   */
  const [overrides, setOverrides] = useState<
    Partial<Record<SocialPlatform, SocialPerPlatformOverride>>
  >({});
  /** Which platform's "Customize" panel is currently expanded, if any. */
  const [expandedOverride, setExpandedOverride] = useState<SocialPlatform | null>(null);
  /** AI-write inflight flag -- disables the button + textarea while generating. */
  const [aiGenerating, setAiGenerating] = useState(false);
  /**
   * Optional schedule. Format is the value of an HTML datetime-local input:
   * "YYYY-MM-DDTHH:mm". We convert to ISO 8601 (with seconds) before sending
   * because SocialPostSchema.scheduleAt requires a full datetime string.
   * Empty string means "post immediately".
   */
  const [scheduleAtLocal, setScheduleAtLocal] = useState<string>("");

  // Best-effort login-state probe so the user sees per-platform connection
  // state at compose time. Failures fold to null -- the modal just hides
  // the section. `refreshTick` lets the "Refresh status" button re-run the
  // probe without unmounting the modal (which would blow away the caption +
  // platform-check local state the founder has typed/toggled).
  useEffect(() => {
    let cancelled = false;
    setRefreshing(true);
    socialLoginState(props.backend, props.adapterOpts)
      .then((r) => {
        if (!cancelled) setLoginState(r);
      })
      .catch(() => {
        if (!cancelled) setLoginState(null);
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.backend, props.adapterOpts, refreshTick]);

  const handleRefreshLoginState = () => {
    setRefreshTick((n) => n + 1);
  };

  /**
   * Slice 8: AI-write caption via the Founder OS LLM gateway (NOT
   * social-poster's direct OpenAI call). pickActiveProvider chooses the
   * subscription-preferred provider for this machine; the call honours
   * the user's existing Anthropic / OpenAI / Gemini settings.
   */
  const handleAIWrite = async () => {
    if (aiGenerating || submitting) return;
    setAiGenerating(true);
    try {
      const generated = await generateSocialCaption({
        baseText: text,
        platforms,
        capChars: tightestCap,
        ventureSlug: props.ventureSlug,
      });
      if (generated.length > 0) {
        setText(generated);
        pushToast({
          kind: "info",
          message: "Caption drafted via Founder OS LLM gateway.",
          ttlMs: 4000,
        });
      }
    } catch (err) {
      if (err instanceof NoLlmProviderAvailableError) {
        pushToast({ kind: "warn", message: err.message, ttlMs: 8000 });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        pushToast({
          kind: "warn",
          message: `AI write failed: ${msg}`,
          ttlMs: 8000,
        });
      }
    } finally {
      setAiGenerating(false);
    }
  };

  const togglePlatform = (p: SocialPlatform) => {
    setPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
    );
  };

  // The text cap is set by the SHORTEST selected platform -- once the user
  // crosses that line every batch above the cap gets trimmed by the adapter.
  // We surface the limit so the user can keep edits under it themselves.
  const tightestCap = useMemo<number>(() => {
    if (platforms.length === 0) return 280;
    let lowest = Number.POSITIVE_INFINITY;
    for (const p of platforms) {
      const cap = SOCIAL_PLATFORM_CAPTION_CAPS[p];
      if (cap < lowest) lowest = cap;
    }
    return lowest === Number.POSITIVE_INFINITY ? 280 : lowest;
  }, [platforms]);

  const canSubmit =
    !submitting && text.trim().length > 0 && platforms.length > 0;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    // Drop overrides for platforms that aren't selected, and strip empty
    // overrides (no text + no hashtags) so we don't write noise to the
    // result log. Per-platform empty -> falls back to base text per spec
    // sec 5.
    const activeOverrides: Partial<Record<SocialPlatform, SocialPerPlatformOverride>> = {};
    for (const p of platforms) {
      const ov = overrides[p];
      if (!ov) continue;
      const hasText = typeof ov.text === "string" && ov.text.length > 0;
      const hasTags = Array.isArray(ov.hashtags) && ov.hashtags.length > 0;
      if (hasText || hasTags) {
        activeOverrides[p] = {
          ...(hasText ? { text: ov.text } : {}),
          ...(hasTags ? { hashtags: ov.hashtags } : {}),
        };
      }
    }
    // Convert datetime-local "YYYY-MM-DDTHH:mm" -> full ISO 8601 with
    // seconds + Z. The browser already interprets the value as local
    // time, so new Date(local) gives the right epoch ms.
    let scheduleIso: string | undefined;
    if (scheduleAtLocal.trim().length > 0) {
      const d = new Date(scheduleAtLocal);
      if (Number.isFinite(d.getTime())) {
        scheduleIso = d.toISOString();
      }
    }
    const payload: SocialPost = {
      ventureSlug: props.ventureSlug,
      text,
      platforms,
      ...(media.length > 0 ? { media: [...media] } : {}),
      ...(Object.keys(activeOverrides).length > 0
        ? { perPlatformOverrides: activeOverrides }
        : {}),
      ...(scheduleIso ? { scheduleAt: scheduleIso } : {}),
    };
    setSubmitting(true);
    props.onPosting();
    try {
      const out = await runSocialPost({
        payload,
        backend: props.backend,
        ventureRoot: props.ventureRoot,
        adapter: props.adapterOpts,
      });
      if (out.scheduled) {
        pushToast({
          kind: "info",
          message: `Queued for ${out.scheduled.fireAt}. The queue file is at ${out.scheduled.queuePath} -- wire the CLI command into Task Scheduler or the schedule skill.`,
          ttlMs: 10000,
        });
      }
      props.onPosted(out.result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      props.onError(msg);
      pushToast({
        kind: "warn",
        message: `Post failed: ${msg}`,
        ttlMs: 8000,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={(e) => {
        // Backdrop click cancels; clicks inside the panel don't bubble.
        if (e.target === e.currentTarget && !submitting) props.onCancel();
      }}
    >
      <div
        style={{
          background: "var(--bg-base)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 10,
          padding: 20,
          width: "min(560px, 92vw)",
          maxHeight: "92vh",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>
            Compose post -- {props.backend}
          </h2>
          <button
            type="button"
            onClick={props.onCancel}
            disabled={submitting}
            style={{
              padding: "4px 10px",
              background: "transparent",
              border: "1px solid var(--border-subtle)",
              color: "var(--text-secondary)",
              borderRadius: 6,
              fontSize: 12,
              cursor: submitting ? "default" : "pointer",
            }}
          >
            Close
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
              Caption ({text.length}/{tightestCap} for the tightest selected platform)
            </span>
            <button
              type="button"
              onClick={() => void handleAIWrite()}
              disabled={aiGenerating || submitting}
              title="Draft a caption via the Founder OS LLM gateway (subscription-preferred routing)."
              style={{
                padding: "3px 8px",
                fontSize: 11,
                fontWeight: 600,
                background: "transparent",
                border: "1px solid var(--border-subtle)",
                color: "var(--text-secondary)",
                borderRadius: 4,
                cursor: aiGenerating || submitting ? "default" : "pointer",
                opacity: aiGenerating || submitting ? 0.6 : 1,
              }}
            >
              {aiGenerating ? "Drafting..." : text.trim() ? "AI rewrite" : "AI write"}
            </button>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={submitting || aiGenerating}
            rows={6}
            style={{
              fontFamily: "inherit",
              fontSize: 13,
              padding: 10,
              background: "var(--bg-elevated)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 6,
              resize: "vertical",
              minHeight: 100,
            }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
              Platforms
            </span>
            <button
              type="button"
              onClick={handleRefreshLoginState}
              disabled={refreshing || submitting}
              title="Re-probe per-platform login state. Use after `sp login <platform>` in your terminal."
              style={{
                padding: "3px 8px",
                fontSize: 11,
                fontWeight: 600,
                background: "transparent",
                border: "1px solid var(--border-subtle)",
                color: "var(--text-secondary)",
                borderRadius: 4,
                cursor: refreshing || submitting ? "default" : "pointer",
                opacity: refreshing || submitting ? 0.6 : 1,
              }}
            >
              {refreshing ? "Refreshing..." : "Refresh status"}
            </button>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {ALL_PLATFORMS.map((p) => {
              const isOn = platforms.includes(p);
              const state = loginState?.state?.[p];
              const dot =
                state === "logged_in"
                  ? "var(--accent-hover)"
                  : state === "logged_out"
                    ? "var(--danger, #c46161)"
                    : "var(--border-subtle)";
              return (
                <span
                  key={p}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "4px 8px",
                    background: isOn ? "var(--accent-soft)" : "var(--bg-elevated)",
                    border: `1px solid ${isOn ? "var(--accent-soft)" : "var(--border-subtle)"}`,
                    borderRadius: 6,
                    fontSize: 12,
                    color: isOn ? "var(--accent-hover)" : "var(--text-secondary)",
                  }}
                >
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      cursor: submitting ? "default" : "pointer",
                    }}
                    title={
                      state === "logged_in"
                        ? `${p}: logged in`
                        : state === "logged_out"
                          ? `${p}: not logged in. Run \`sp login ${p}\` in your terminal then refresh.`
                          : `${p}: login state unknown`
                    }
                  >
                    <input
                      type="checkbox"
                      checked={isOn}
                      onChange={() => togglePlatform(p)}
                      disabled={submitting}
                      style={{ margin: 0 }}
                    />
                    <span
                      aria-hidden="true"
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 999,
                        background: dot,
                        display: "inline-block",
                      }}
                    />
                    {p}
                  </label>
                  {state === "logged_out" && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void copyLoginCommand(p);
                      }}
                      disabled={submitting}
                      title={`Copy \`sp login ${p}\` to clipboard`}
                      aria-label={`Copy sp login ${p} command`}
                      style={{
                        padding: "2px 6px",
                        fontSize: 10,
                        fontWeight: 600,
                        background: "transparent",
                        border: "1px solid var(--border-subtle)",
                        color: "var(--text-secondary)",
                        borderRadius: 4,
                        cursor: submitting ? "default" : "pointer",
                        lineHeight: 1.2,
                      }}
                    >
                      Copy login
                    </button>
                  )}
                  {isOn && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setExpandedOverride((cur) => (cur === p ? null : p));
                      }}
                      disabled={submitting}
                      title={
                        overrides[p]
                          ? `Customize ${p} caption (set)`
                          : `Customize ${p} caption`
                      }
                      aria-label={`Customize ${p} caption`}
                      aria-expanded={expandedOverride === p}
                      style={{
                        padding: "2px 6px",
                        fontSize: 10,
                        fontWeight: 600,
                        background:
                          overrides[p] !== undefined
                            ? "var(--accent-soft)"
                            : "transparent",
                        border: "1px solid var(--border-subtle)",
                        color:
                          overrides[p] !== undefined
                            ? "var(--accent-hover)"
                            : "var(--text-secondary)",
                        borderRadius: 4,
                        cursor: submitting ? "default" : "pointer",
                        lineHeight: 1.2,
                      }}
                    >
                      {overrides[p] !== undefined ? "✎ custom" : "Customize"}
                    </button>
                  )}
                </span>
              );
            })}
          </div>
          {expandedOverride && platforms.includes(expandedOverride) && (
            <OverridePanel
              platform={expandedOverride}
              override={overrides[expandedOverride]}
              baseText={text}
              disabled={submitting}
              onChange={(next) => {
                setOverrides((prev) => {
                  const copy = { ...prev };
                  if (next === undefined) {
                    delete copy[expandedOverride];
                  } else {
                    copy[expandedOverride] = next;
                  }
                  return copy;
                });
              }}
              onClose={() => setExpandedOverride(null)}
            />
          )}
        </div>

        {media.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
              Attached media
            </span>
            <ul
              style={{
                margin: 0,
                paddingLeft: 18,
                fontSize: 12,
                color: "var(--text-secondary)",
              }}
            >
              {media.map((m) => (
                <li key={m.path}>
                  <code>{m.path}</code> ({m.kind})
                </li>
              ))}
            </ul>
          </div>
        )}

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
            Schedule (optional)
          </span>
          <input
            type="datetime-local"
            value={scheduleAtLocal}
            onChange={(e) => setScheduleAtLocal(e.target.value)}
            disabled={submitting}
            style={{
              fontFamily: "inherit",
              fontSize: 13,
              padding: "6px 8px",
              background: "var(--bg-elevated)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 6,
              maxWidth: 220,
            }}
          />
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {props.backend === "social-poster"
              ? "social-poster has no native scheduler -- this queues the payload under 13_social/scheduled/ for the OS scheduler or the `schedule` skill."
              : "postiz fires this server-side -- no queue file is written."}
          </span>
        </label>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={props.onCancel}
            disabled={submitting}
            style={{
              padding: "8px 14px",
              background: "transparent",
              border: "1px solid var(--border-subtle)",
              color: "var(--text-secondary)",
              borderRadius: 6,
              fontSize: 13,
              cursor: submitting ? "default" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{
              padding: "8px 14px",
              background: canSubmit ? "var(--accent-soft)" : "var(--bg-elevated)",
              border: `1px solid ${canSubmit ? "var(--accent-soft)" : "var(--border-subtle)"}`,
              color: canSubmit ? "var(--accent-hover)" : "var(--text-muted)",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              cursor: canSubmit ? "pointer" : "default",
            }}
            title={
              !canSubmit
                ? "Caption + at least one platform required"
                : `Post to ${platforms.length} platform${platforms.length === 1 ? "" : "s"} via ${props.backend}`
            }
          >
            {submitting ? "Posting..." : `Post to ${platforms.length} platform${platforms.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-platform override panel -- slice 5 of the SOCIAL-MODULE follow-up arc.
// ---------------------------------------------------------------------------

type OverridePanelProps = {
  platform: SocialPlatform;
  override: SocialPerPlatformOverride | undefined;
  baseText: string;
  disabled: boolean;
  onChange: (next: SocialPerPlatformOverride | undefined) => void;
  onClose: () => void;
};

/**
 * Inline panel that lets the founder override the caption + hashtags for a
 * specific platform. SocialPost.perPlatformOverrides supports this natively
 * (see social-core/index.ts SocialPerPlatformOverrideSchema); this is the
 * UX surface that finally exercises it.
 *
 * Behavior:
 *   - Leaving the textarea blank means "use the base caption" -- only
 *     hashtags get applied.
 *   - Hashtags input is a comma-separated string; we split on commas,
 *     trim, drop empties, and store as an array. Rendering as chips on
 *     the wire is the adapter's job (it joins `#a #b` onto the caption).
 *   - Clear button removes the override entry entirely so the platform
 *     falls back to base text.
 */
function OverridePanel(props: OverridePanelProps) {
  const cap = SOCIAL_PLATFORM_CAPTION_CAPS[props.platform];
  const text = props.override?.text ?? "";
  const hashtagsRaw = (props.override?.hashtags ?? []).join(", ");

  return (
    <div
      style={{
        marginTop: 6,
        padding: 10,
        background: "var(--bg-elevated)",
        border: "1px solid var(--accent-soft)",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--accent-hover)" }}>
          Customize for {props.platform} (cap {cap})
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          {props.override !== undefined && (
            <button
              type="button"
              onClick={() => props.onChange(undefined)}
              disabled={props.disabled}
              title={`Clear override -- ${props.platform} falls back to the base caption`}
              style={{
                padding: "3px 8px",
                background: "transparent",
                border: "1px solid var(--border-subtle)",
                color: "var(--text-secondary)",
                borderRadius: 4,
                fontSize: 11,
                cursor: props.disabled ? "default" : "pointer",
              }}
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={props.onClose}
            disabled={props.disabled}
            style={{
              padding: "3px 8px",
              background: "transparent",
              border: "1px solid var(--border-subtle)",
              color: "var(--text-secondary)",
              borderRadius: 4,
              fontSize: 11,
              cursor: props.disabled ? "default" : "pointer",
            }}
          >
            Done
          </button>
        </div>
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
          Caption ({text.length}/{cap}) -- leave blank to inherit the base caption
        </span>
        <textarea
          value={text}
          onChange={(e) => {
            const newText = e.target.value;
            const tags = props.override?.hashtags ?? [];
            if (!newText && tags.length === 0) {
              props.onChange(undefined);
              return;
            }
            props.onChange({
              ...(newText ? { text: newText } : {}),
              ...(tags.length > 0 ? { hashtags: tags } : {}),
            });
          }}
          placeholder={props.baseText.slice(0, 80)}
          disabled={props.disabled}
          rows={3}
          style={{
            fontFamily: "inherit",
            fontSize: 12,
            padding: 8,
            background: "var(--bg-base)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 4,
            resize: "vertical",
            minHeight: 60,
          }}
        />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
          Hashtags (comma-separated, with or without #)
        </span>
        <input
          type="text"
          value={hashtagsRaw}
          onChange={(e) => {
            const tags = e.target.value
              .split(",")
              .map((t) => t.trim())
              .filter((t) => t.length > 0);
            const txt = props.override?.text;
            if (!txt && tags.length === 0) {
              props.onChange(undefined);
              return;
            }
            props.onChange({
              ...(txt ? { text: txt } : {}),
              ...(tags.length > 0 ? { hashtags: tags } : {}),
            });
          }}
          placeholder="launch, founderlife, indiehackers"
          disabled={props.disabled}
          style={{
            fontFamily: "inherit",
            fontSize: 12,
            padding: "6px 8px",
            background: "var(--bg-base)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 4,
          }}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
    </div>
  );
}
