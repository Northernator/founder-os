import { useState } from "react";

import type { BrandNameCandidate, BrandNameStatus } from "../../lib/brand-names.js";

/**
 * Persistent triage list for generated brand-name candidates.
 *
 * Renders three groups:
 *   POSSIBLE — names the founder is considering. Green-tinted header.
 *              Possible rows expose Pick (set as venture name) plus
 *              the full check action cluster.
 *   NEW      — just-generated, undecided names. Each row carries the
 *              triage buttons so the founder can move names out of
 *              new in either direction; checks are also exposed so
 *              the founder can research before committing.
 *   FAIL     — rejected names. Red-tinted header. Collapsed by default
 *              so old failures don't dominate the view; the chevron
 *              expands them. Failures show ONLY the "Move back to new"
 *              affordance — running checks against rejected names
 *              would be wasted API quota.
 *
 * The `info` payload on each candidate is whatever brand-gen wrote
 * (today: a NamingCandidate snapshot, optionally enriched with
 * `domainStatus`, `socialStatus`, `trademarkStatus`). The renderer
 * reads fields defensively — partial payloads are normal during
 * regeneration races and we'd rather show "(checking…)" than crash
 * the whole list.
 */

type CheckKind = "domain" | "social" | "trademark";

export interface NameTriageListProps {
  candidates: BrandNameCandidate[];
  /** Triage status transition (Possible / Fail / back to new). */
  onMark: (name: string, status: BrandNameStatus) => void;
  /** Run a single availability sweep and persist results. */
  onCheck: (name: string, kind: CheckKind) => void;
  /** Run all three sweeps concurrently. */
  onCheckAll: (name: string) => void;
  /** Set the venture's chosen name. Only invoked on Possible rows. */
  onPick: (name: string) => void;
  /** Currently chosen venture name (case-sensitive); empty if none. */
  chosenName?: string;
  /**
   * Map of in-flight checks per candidate name. The row reads it to
   * show spinners on the relevant chip while a sweep is running.
   * Driven from BrandTab so multi-row "Check all" doesn't double-fire.
   */
  checking?: Record<string, Set<CheckKind>>;
}

type SectionKind = "possible" | "new" | "fail";

const SECTION_STYLE: Record<
  SectionKind,
  { headerBg: string; headerColor: string; borderColor: string; label: string }
> = {
  possible: {
    headerBg: "var(--success-soft)",
    headerColor: "var(--success)",
    borderColor: "var(--success-soft)",
    label: "Possible",
  },
  new: {
    headerBg: "var(--bg-elevated)",
    headerColor: "var(--text-secondary)",
    borderColor: "var(--border-subtle)",
    label: "New",
  },
  fail: {
    headerBg: "var(--danger-soft)",
    headerColor: "var(--danger)",
    borderColor: "var(--danger-border)",
    label: "Fail",
  },
};

export function NameTriageList({
  candidates,
  onMark,
  onCheck,
  onCheckAll,
  onPick,
  chosenName,
  checking,
}: NameTriageListProps) {
  // Failures stay collapsed by default — the founder cares about
  // possibles + the fresh batch, and a long fail list adds noise.
  // Local state, deliberately not persisted: it's a per-view affordance
  // and survives across re-renders within a single Brand-tab visit.
  const [failOpen, setFailOpen] = useState(false);

  const possible = candidates.filter((c) => c.status === "possible");
  const fresh = candidates.filter((c) => c.status === "new");
  const failed = candidates.filter((c) => c.status === "fail");

  if (candidates.length === 0) {
    return (
      <div
        style={{
          padding: 20,
          background: "var(--bg-elevated)",
          border: "1px dashed var(--border-subtle)",
          borderRadius: 8,
          textAlign: "center",
          fontSize: 13,
          color: "var(--text-muted)",
        }}
      >
        No candidates yet. Generate some or add one manually above.
      </div>
    );
  }

  const rowProps = (c: BrandNameCandidate) => ({
    candidate: c,
    onMark,
    onCheck,
    onCheckAll,
    onPick,
    chosenName,
    checkingKinds: checking?.[c.name],
    aPossiblePicked: chosenName != null && chosenName.length > 0,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Section kind="possible" count={possible.length}>
        {possible.length === 0 ? (
          <EmptyHint message="Names you mark as Possible from the New section will land here." />
        ) : (
          possible.map((c) => <CandidateRow key={c.name} {...rowProps(c)} />)
        )}
      </Section>

      <Section kind="new" count={fresh.length}>
        {fresh.length === 0 ? (
          <EmptyHint message='Click "Generate names" to add fresh candidates.' />
        ) : (
          fresh.map((c) => <CandidateRow key={c.name} {...rowProps(c)} />)
        )}
      </Section>

      <Section
        kind="fail"
        count={failed.length}
        collapsible
        open={failOpen}
        onToggle={() => setFailOpen((o) => !o)}
      >
        {failOpen &&
          (failed.length === 0 ? (
            <EmptyHint message="Rejected names will be remembered here so regeneration doesn't re-surface them." />
          ) : (
            failed.map((c) => <CandidateRow key={c.name} {...rowProps(c)} />)
          ))}
      </Section>
    </div>
  );
}

// ─── Section frame ────────────────────────────────────────────────────────

function Section({
  kind,
  count,
  collapsible,
  open,
  onToggle,
  children,
}: {
  kind: SectionKind;
  count: number;
  /** When true, the header acts as a button and the body is gated on `open`. */
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}) {
  const style = SECTION_STYLE[kind];

  return (
    <div
      style={{
        border: `1px solid ${style.borderColor}`,
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={collapsible ? onToggle : undefined}
        disabled={!collapsible}
        style={{
          width: "100%",
          textAlign: "left",
          padding: "10px 14px",
          background: style.headerBg,
          color: style.headerColor,
          border: "none",
          borderBottom: `1px solid ${style.borderColor}`,
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: 0.3,
          textTransform: "uppercase",
          cursor: collapsible ? "pointer" : "default",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        {collapsible && <span style={{ fontSize: 11, opacity: 0.7 }}>{open ? "▾" : "▸"}</span>}
        <span>{style.label}</span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 999,
            background: style.headerColor,
            color: "var(--bg-panel)",
            fontWeight: 700,
          }}
        >
          {count}
        </span>
      </button>
      <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {children}
      </div>
    </div>
  );
}

function EmptyHint({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: "12px 14px",
        fontSize: 12,
        color: "var(--text-muted)",
        fontStyle: "italic",
      }}
    >
      {message}
    </div>
  );
}

// ─── One candidate row ────────────────────────────────────────────────────

interface CandidateRowProps {
  candidate: BrandNameCandidate;
  onMark: (name: string, status: BrandNameStatus) => void;
  onCheck: (name: string, kind: CheckKind) => void;
  onCheckAll: (name: string) => void;
  onPick: (name: string) => void;
  chosenName?: string;
  checkingKinds?: Set<CheckKind>;
  /** True when SOME possible has been picked — controls "Pick instead" wording. */
  aPossiblePicked: boolean;
}

function CandidateRow({
  candidate,
  onMark,
  onCheck,
  onCheckAll,
  onPick,
  chosenName,
  checkingKinds,
  aPossiblePicked,
}: CandidateRowProps) {
  const { name, info, status, createdAt, decidedAt } = candidate;
  const rationale = readString(info, "rationale");
  const style = readString(info, "style");
  const domainSummary = summariseStatusMap(info.domainStatus);
  const trademarkSummary = summariseStatusMap(info.trademarkStatus);
  const socialSummary = summariseStatusMap(info.socialStatus);
  const timestamp = decidedAt ?? createdAt;
  const isChosen = !!chosenName && chosenName.toLowerCase() === name.toLowerCase();
  // Failures don't research — running checks against a rejected name
  // would burn API quota for no decision-relevant reason.
  const showChecks = status !== "fail";

  const isChecking = (kind: CheckKind) => !!checkingKinds?.has(kind);
  const anyChecking = !!checkingKinds && checkingKinds.size > 0;

  return (
    <div
      style={{
        border: `1px solid ${isChosen ? "var(--accent)" : "var(--border-subtle)"}`,
        borderRadius: 6,
        padding: "10px 12px",
        background: isChosen ? "var(--accent-soft)" : "var(--bg-panel)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>{name}</span>
        {style && (
          <span
            style={{
              fontSize: 10,
              color: "var(--text-tertiary)",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            {style}
          </span>
        )}
        {isChosen && (
          <span
            style={{
              fontSize: 10,
              padding: "2px 8px",
              borderRadius: 999,
              background: "var(--accent)",
              color: "var(--bg-panel)",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 0.4,
            }}
          >
            ✓ Chosen
          </span>
        )}
      </div>
      {rationale && (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.45 }}>{rationale}</p>
      )}

      {showChecks && (
        <div
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <CheckChip
            label="Domains"
            summary={domainSummary}
            loading={isChecking("domain")}
            onClick={() => onCheck(name, "domain")}
            populated={hasEntries(info.domainStatus)}
          />
          <CheckChip
            label="Trademark"
            summary={trademarkSummary}
            loading={isChecking("trademark")}
            onClick={() => onCheck(name, "trademark")}
            populated={hasEntries(info.trademarkStatus)}
          />
          <CheckChip
            label="Socials"
            summary={socialSummary}
            loading={isChecking("social")}
            onClick={() => onCheck(name, "social")}
            populated={hasEntries(info.socialStatus)}
          />
          <button
            type="button"
            onClick={() => onCheckAll(name)}
            disabled={anyChecking}
            title="Run domain + trademark + socials in parallel"
            style={{
              padding: "4px 10px",
              fontSize: 11,
              background: anyChecking ? "var(--bg-hover)" : "var(--bg-panel)",
              color: anyChecking ? "var(--text-muted)" : "var(--text-secondary)",
              border: "1px solid var(--border-input)",
              borderRadius: 4,
              fontWeight: 600,
              cursor: anyChecking ? "not-allowed" : "pointer",
            }}
          >
            🔍 Check all
          </button>
        </div>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
          fontSize: 11,
          color: "var(--text-muted)",
        }}
      >
        <span title={`Created ${createdAt}${decidedAt ? ` · decided ${decidedAt}` : ""}`}>
          {decidedAt ? "Decided " : "Added "}
          {formatRelative(timestamp)}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
          <RowAction
            status={status}
            name={name}
            isChosen={isChosen}
            aPossiblePicked={aPossiblePicked}
            onMark={onMark}
            onPick={onPick}
          />
        </span>
      </div>
    </div>
  );
}

/**
 * Renders the trailing action buttons. New rows expose explicit
 * Possible / Fail moves. Possible rows expose Pick (set venture name)
 * plus Move-back-to-new. Fail rows show only Move-back-to-new so the
 * founder can recover from a misclick without losing the row.
 */
function RowAction({
  status,
  name,
  isChosen,
  aPossiblePicked,
  onMark,
  onPick,
}: {
  status: BrandNameStatus;
  name: string;
  isChosen: boolean;
  aPossiblePicked: boolean;
  onMark: (name: string, status: BrandNameStatus) => void;
  onPick: (name: string) => void;
}) {
  if (status === "new") {
    return (
      <>
        <button
          type="button"
          onClick={() => onMark(name, "possible")}
          style={triageButton("var(--success)")}
          title="Move to Possible"
        >
          ✓ Possible
        </button>
        <button
          type="button"
          onClick={() => onMark(name, "fail")}
          style={triageButton("var(--danger)")}
          title="Reject — kept on file so regen won't re-suggest"
        >
          ✗ Fail
        </button>
      </>
    );
  }
  if (status === "possible") {
    return (
      <>
        {!isChosen && (
          <button
            type="button"
            onClick={() => onPick(name)}
            style={primaryPickButton}
            title="Set as the venture's chosen name"
          >
            {aPossiblePicked ? "Pick instead →" : "Pick →"}
          </button>
        )}
        <button
          type="button"
          onClick={() => onMark(name, "new")}
          style={ghostLinkButton}
          title="Move this row back to the New section"
        >
          ↺ Move back to new
        </button>
      </>
    );
  }
  // fail
  return (
    <button
      type="button"
      onClick={() => onMark(name, "new")}
      style={ghostLinkButton}
      title="Move this row back to the New section"
    >
      ↺ Move back to new
    </button>
  );
}

function triageButton(color: string): React.CSSProperties {
  return {
    padding: "4px 10px",
    fontSize: 11,
    background: "var(--bg-panel)",
    color,
    border: `1px solid ${color}`,
    borderRadius: 4,
    fontWeight: 700,
    cursor: "pointer",
  };
}

const primaryPickButton: React.CSSProperties = {
  padding: "4px 12px",
  fontSize: 11,
  background: "var(--accent)",
  color: "var(--bg-panel)",
  border: "1px solid var(--accent)",
  borderRadius: 4,
  fontWeight: 700,
  cursor: "pointer",
};

const ghostLinkButton: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--accent)",
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
  padding: "2px 4px",
};

// ─── CheckChip — combined button + summary chip ──────────────────────────

function CheckChip({
  label,
  summary,
  loading,
  populated,
  onClick,
}: {
  label: string;
  summary: string;
  loading: boolean;
  populated: boolean;
  onClick: () => void;
}) {
  // When data is missing we show a "Check X" button. Once data lands
  // the chip swaps to a compact summary; clicking it re-runs the check
  // (refresh path). The visual difference signals "this is data" vs.
  // "this is an action" without taking up extra row space.
  const idle = !loading;
  const background = populated ? "var(--bg-elevated)" : "var(--bg-panel)";
  const border = populated ? "var(--border-input)" : "var(--border-input)";
  const color = populated ? "var(--text-primary)" : "var(--text-secondary)";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      title={
        populated
          ? `${label}: ${summary} — click to refresh`
          : `Run ${label.toLowerCase()} availability check`
      }
      style={{
        padding: "4px 10px",
        fontSize: 11,
        background,
        color,
        border: `1px solid ${border}`,
        borderRadius: 4,
        fontWeight: 600,
        cursor: idle ? "pointer" : "wait",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        opacity: loading ? 0.7 : 1,
      }}
    >
      {loading ? <Spinner /> : populated ? <span>✓</span> : <span>🔍</span>}
      <span style={{ color: "var(--text-tertiary)", fontWeight: 500 }}>{label}:</span>
      <span>{loading ? "Checking…" : populated ? summary : "(check)"}</span>
    </button>
  );
}

function Spinner() {
  // Pure-CSS spinner using the global `spin` keyframe declared once
  // in App.tsx. Skipping the keyframe locally avoids duplicate
  // definitions and keeps the bundle tiny.
  return (
    <span
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        border: "2px solid var(--border-input)",
        borderTopColor: "var(--accent)",
        borderRadius: "50%",
        animation: "spin 0.7s linear infinite",
      }}
    />
  );
}

// ─── Defensive readers for the info payload ───────────────────────────────

function readString(info: Record<string, unknown>, key: string): string | undefined {
  const v = info[key];
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

function hasEntries(map: unknown): boolean {
  if (!map || typeof map !== "object") return false;
  return Object.keys(map as Record<string, unknown>).length > 0;
}

/**
 * Summarise a `{ "<key>": { status, ... } }` map into a short human
 * label. The shape mirrors NamingCandidate.domainStatus /
 * trademarkStatus / socialStatus — keyed by full domain or
 * jurisdiction or platform, with each value carrying a status string.
 *
 * Returns "(not yet checked)" when the map is empty so the user
 * knows nothing has been probed, distinct from "all available".
 */
function summariseStatusMap(map: unknown): string {
  if (!map || typeof map !== "object") return "(not yet checked)";
  const entries = Object.values(map as Record<string, unknown>);
  if (entries.length === 0) return "(not yet checked)";

  let available = 0;
  let taken = 0;
  let unknown = 0;
  let other = 0;
  for (const entry of entries) {
    const status =
      entry && typeof entry === "object" ? (entry as { status?: unknown }).status : undefined;
    if (status === "available") available += 1;
    else if (status === "taken" || status === "parked") taken += 1;
    else if (status === "unknown" || status == null) unknown += 1;
    else other += 1;
  }

  if (available + taken + other === 0) return "(checking…)";
  const parts: string[] = [];
  if (available) parts.push(`${available} ok`);
  if (taken) parts.push(`${taken} taken`);
  if (other) parts.push(`${other} flagged`);
  if (unknown) parts.push(`${unknown} ?`);
  return parts.join(" · ");
}

/**
 * Friendly timestamp. Absolute date in the title tooltip, relative
 * label inline so the row stays scannable. Falls back to the raw
 * string when parsing fails.
 */
function formatRelative(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const diff = Date.now() - ms;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ms).toLocaleDateString();
}
