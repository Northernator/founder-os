/**
 * ProviderModeBadge -- single source of truth for the "API" vs
 * "Subscription" pill rendered everywhere an LLM call could fire.
 *
 * The user has explicitly asked for the wording to be unambiguous about
 * which path costs money: API hits the provider's HTTP API and bills the
 * user's API key on the spot; Subscription shells out to the vendor CLI
 * (`claude`, `codex`, `gemini`) and is covered by their existing Pro /
 * Plus / Advanced consumer subscription.
 *
 * Colour scheme:
 *   - subscription -> green   (matches chat-ui PRO pill -- "good, free")
 *   - api_key      -> amber   (warning -- "this costs money")
 *   - unknown      -> grey    (no usable provider configured yet)
 *
 * The amber on API is deliberate. A user who's nominally on "subscription
 * everywhere" should feel an instant visual jolt if anything routes to
 * api_key by mistake -- which is exactly the bug class that prompted this
 * arc (£5 unexpectedly spent because mode defaulted to api_key in the
 * VentureDashboard chat caller).
 *
 * Variants:
 *   - "pill"  full-text badge ("Subscription" / "API"); use in headers and
 *             single-mode anchors.
 *   - "short" 3-letter ("SUB" / "API"); use in dense lists, chat bubbles,
 *             multi-line stage-runner rows where vertical room is tight.
 *
 * The provider id is passed in for completeness even though we only use
 * it for ARIA / title attributes -- the rendered text doesn't repeat the
 * provider name (the caller already labels which provider this is for).
 */
import type { LlmMode } from "./db.js";

export type ProviderModeBadgeProps = {
  mode: LlmMode | null;
  /** Provider id used for accessible labels only. Optional. */
  provider?: string;
  /** "pill" (default) or "short". */
  variant?: "pill" | "short";
  /** Inline style overrides. Use sparingly; the colour scheme is load-bearing. */
  style?: React.CSSProperties;
};

const SUB_GREEN = { bg: "#ECFDF5", fg: "#047857" };
const API_AMBER = { bg: "#FEF3C7", fg: "#B45309" };
const UNKNOWN_GREY = { bg: "#F3F4F6", fg: "#6B7280" };

function paletteFor(mode: LlmMode | null): { bg: string; fg: string } {
  if (mode === "subscription") return SUB_GREEN;
  if (mode === "api_key") return API_AMBER;
  return UNKNOWN_GREY;
}

function labelFor(mode: LlmMode | null, variant: "pill" | "short"): string {
  if (mode === "subscription") return variant === "short" ? "SUB" : "Subscription";
  if (mode === "api_key") return "API";
  return variant === "short" ? "—" : "Not set";
}

export function ProviderModeBadge({
  mode,
  provider,
  variant = "pill",
  style,
}: ProviderModeBadgeProps) {
  const { bg, fg } = paletteFor(mode);
  const label = labelFor(mode, variant);
  const ariaText =
    mode === "subscription"
      ? `${provider ?? "Active provider"} routed via subscription CLI -- no API charges`
      : mode === "api_key"
        ? `${provider ?? "Active provider"} routed via HTTP API -- billed to your saved key`
        : `No usable provider configured`;

  return (
    <span
      aria-label={ariaText}
      title={ariaText}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: variant === "short" ? 9 : 11,
        fontWeight: 600,
        padding: variant === "short" ? "1px 5px" : "2px 8px",
        borderRadius: 4,
        background: bg,
        color: fg,
        letterSpacing: variant === "short" ? 0.3 : 0.2,
        textTransform: variant === "short" ? "uppercase" : "none",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {label}
    </span>
  );
}

/**
 * Convenience hook payload: pair the provider id with its mode, both
 * pulled from `db.getLlmSetting`. Use in components that already do that
 * lookup -- saves a second query if the caller already has the row.
 */
export type ProviderModeInfo = {
  provider: string | null;
  mode: LlmMode | null;
};
