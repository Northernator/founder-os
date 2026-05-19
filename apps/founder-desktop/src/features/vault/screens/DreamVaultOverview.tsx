/**
 * DreamVaultOverview -- the Dream Vault home grid + filters.
 *
 * Spec §3 slice 10 sections:
 *   - Recent imports (pending + committed runs)
 *   - Projects (per venture + Unsorted bucket)
 *   - Inbox (committed unsorted sources)
 *   - Documents / Images / Prompts / Tasks / Decisions / Research / Code wiki
 *   - Import logs (runner log lines per import)
 *
 * Filters per the spec: source type, provider, confidence, needs-review,
 * unsorted. All work over the in-memory pending + recent maps. Once
 * slice 12 wires Rust IPC for the SQLite vault tables we plumb the
 * on-disk source through this same filter pipeline.
 */
import type { Venture } from "@founder-os/domain";
import type { Confidence, ExtractedItem, SourceDocument } from "@founder-os/vault-contract";
import type { VaultNoteDraft } from "@founder-os/vault-runner";
import { useMemo, useState } from "react";
import { VaultPendingImportsPanel } from "../VaultPendingImportsPanel.js";
import type { PendingVaultImport, RecentVaultImport, RecoveredVaultImport } from "../types.js";

const SOURCE_TYPES = ["document", "image", "chat", "transcript", "spreadsheet", "code", "structured", "other"] as const;
const SOURCE_PROVIDERS = ["local", "google_drive", "paste", "manual"] as const;
const CONFIDENCES = ["high", "medium", "low"] as const;
/**
 * Spec §3 slice 10 sections that map onto ExtractedItem.type values.
 * Documents / Images sections are derived from source-type instead --
 * see DocumentsImagesSection below.
 */
const ITEM_KIND_SECTIONS: Array<{ key: string; title: string; types: ExtractedItem["type"][] }> = [
  { key: "prompts", title: "Prompts", types: ["prompt"] },
  { key: "tasks", title: "Tasks", types: ["task", "todo"] },
  { key: "decisions", title: "Decisions", types: ["decision"] },
  { key: "research", title: "Research", types: ["research_finding", "question", "fact", "summary", "idea"] },
  { key: "code-wiki", title: "Code wiki", types: ["code_snippet"] },
  { key: "brand", title: "Brand & UI references", types: ["brand_reference", "ui_reference"] },
];

export type DreamVaultOverviewProps = {
  ventures: Venture[];
  pending: ReadonlyMap<string, PendingVaultImport>;
  recovered?: ReadonlyMap<string, RecoveredVaultImport>;
  recent: ReadonlyArray<RecentVaultImport>;
  onReviewPending: (jobId: string) => void;
  onDiscardPending: (jobId: string) => void;
  onDiscardRecovered?: (jobId: string) => void;
  onOpenProject: (slug: string | "__unsorted__") => void;
  onOpenSource: (sourceId: string, fromJobId: string) => void;
  onOpenNote: (noteId: string, fromJobId: string) => void;
  onStartImport: () => void;
};

type Filters = {
  sourceType: string | null;
  provider: string | null;
  confidence: Confidence | null;
  needsReviewOnly: boolean;
  unsortedOnly: boolean;
};

const emptyFilters: Filters = {
  sourceType: null,
  provider: null,
  confidence: null,
  needsReviewOnly: false,
  unsortedOnly: false,
};

export function DreamVaultOverview({
  ventures,
  pending,
  recovered,
  recent,
  onReviewPending,
  onDiscardPending,
  onDiscardRecovered,
  onOpenProject,
  onOpenSource,
  onOpenNote,
  onStartImport,
}: DreamVaultOverviewProps) {
  const [filters, setFilters] = useState<Filters>(emptyFilters);

  const allSources = useMemo(() => collectAllSources(pending, recent), [pending, recent]);
  const filteredSources = useMemo(() => applyFilters(allSources, filters), [allSources, filters]);
  const allItems = useMemo(() => collectAllItems(pending, recent), [pending, recent]);
  const allDrafts = useMemo(() => collectAllDrafts(pending, recent), [pending, recent]);

  const projectCounts = useMemo(() => countByVenture(pending, recent), [pending, recent]);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <PrivacyBanner />

      <div
        style={{
          display: "flex",
          gap: 10,
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary, #4B5563)" }}>
          {allSources.length} source{allSources.length === 1 ? "" : "s"} ·{" "}
          {allDrafts.length} draft note{allDrafts.length === 1 ? "" : "s"} ·{" "}
          {pending.size} pending review · {recent.length} committed run
          {recent.length === 1 ? "" : "s"}
        </p>
        <button type="button" onClick={onStartImport} style={primaryBtn}>
          + Import to vault
        </button>
      </div>

      <VaultPendingImportsPanel
        imports={pending}
        {...(recovered ? { recovered } : {})}
        onReview={onReviewPending}
        onDiscard={onDiscardPending}
        {...(onDiscardRecovered ? { onDiscardRecovered } : {})}
      />

      <FiltersBar filters={filters} setFilters={setFilters} />

      <SectionCard title="Recent imports">
        <RecentImportsList
          pending={pending}
          recent={recent}
          onReviewPending={onReviewPending}
        />
      </SectionCard>

      <SectionCard title="Projects">
        <ProjectsGrid
          ventures={ventures}
          counts={projectCounts}
          onOpenProject={onOpenProject}
        />
      </SectionCard>

      <SectionCard title="Sources">
        <SourcesList sources={filteredSources} onOpenSource={onOpenSource} />
      </SectionCard>

      <SectionCard title="Documents">
        <SourcesList
          sources={allSources.filter((s) => s.source.sourceType === "document")}
          onOpenSource={onOpenSource}
        />
      </SectionCard>

      <SectionCard title="Images">
        <SourcesList
          sources={allSources.filter((s) => s.source.sourceType === "image")}
          onOpenSource={onOpenSource}
        />
      </SectionCard>

      <SectionCard title="Drafts &amp; notes">
        <DraftsList drafts={allDrafts} onOpenNote={onOpenNote} />
      </SectionCard>

      {ITEM_KIND_SECTIONS.map((sec) => {
        const items = allItems.filter((row) => sec.types.includes(row.item.type));
        if (items.length === 0) return null;
        return (
          <SectionCard key={sec.key} title={`${sec.title} (${items.length})`}>
            <ItemsList items={items} />
          </SectionCard>
        );
      })}

      <SectionCard title="Import logs">
        <LogsList pending={pending} recent={recent} />
      </SectionCard>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section primitives
// ---------------------------------------------------------------------------

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        border: "1px solid var(--border-subtle, #E5E7EB)",
        borderRadius: 12,
        background: "var(--bg-surface, #FFFFFF)",
        padding: 16,
      }}
    >
      <h3 style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 800 }}>{title}</h3>
      {children}
    </section>
  );
}

function PrivacyBanner() {
  return (
    <div
      style={{
        background: "color-mix(in srgb, var(--accent, #4F46E5) 8%, transparent)",
        border: "1px solid color-mix(in srgb, var(--accent, #4F46E5) 22%, transparent)",
        borderRadius: 10,
        padding: "12px 14px",
        fontSize: 13,
        color: "var(--text-secondary, #4B5563)",
        lineHeight: 1.5,
      }}
    >
      <strong style={{ color: "var(--text-primary, #0F172A)" }}>Local-first vault.</strong> Every
      note here lives on your machine under <code>_vault/</code>. Nothing is uploaded; nothing is
      published.
    </div>
  );
}

function FiltersBar({
  filters,
  setFilters,
}: {
  filters: Filters;
  setFilters: (next: Filters) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        alignItems: "center",
        padding: "10px 12px",
        background: "var(--bg-muted, #F9FAFB)",
        border: "1px solid var(--border-subtle, #E5E7EB)",
        borderRadius: 10,
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary, #4B5563)" }}>
        Filter:
      </span>
      <Select
        label="Type"
        value={filters.sourceType}
        options={SOURCE_TYPES}
        onChange={(v) => setFilters({ ...filters, sourceType: v })}
      />
      <Select
        label="Provider"
        value={filters.provider}
        options={SOURCE_PROVIDERS}
        onChange={(v) => setFilters({ ...filters, provider: v })}
      />
      <Select
        label="Confidence"
        value={filters.confidence}
        options={CONFIDENCES}
        onChange={(v) => setFilters({ ...filters, confidence: (v as Confidence) ?? null })}
      />
      <CheckboxChip
        label="Needs review"
        checked={filters.needsReviewOnly}
        onChange={(checked) => setFilters({ ...filters, needsReviewOnly: checked })}
      />
      <CheckboxChip
        label="Unsorted only"
        checked={filters.unsortedOnly}
        onChange={(checked) => setFilters({ ...filters, unsortedOnly: checked })}
      />
      {(filters.sourceType ||
        filters.provider ||
        filters.confidence ||
        filters.needsReviewOnly ||
        filters.unsortedOnly) && (
        <button type="button" onClick={() => setFilters(emptyFilters)} style={ghostBtn}>
          Clear
        </button>
      )}
    </div>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: ReadonlyArray<string>;
  onChange: (v: string | null) => void;
}) {
  return (
    <label style={{ fontSize: 11, color: "var(--text-secondary, #4B5563)", display: "inline-flex", alignItems: "center", gap: 4 }}>
      {label}
      <select
        value={value ?? "__all__"}
        onChange={(e) => onChange(e.target.value === "__all__" ? null : e.target.value)}
        style={{
          padding: "3px 6px",
          fontSize: 11,
          border: "1px solid var(--border-subtle, #E5E7EB)",
          borderRadius: 6,
          background: "var(--bg-surface, #FFFFFF)",
        }}
      >
        <option value="__all__">all</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </label>
  );
}

function CheckboxChip({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        padding: "3px 8px",
        border: "1px solid var(--border-subtle, #E5E7EB)",
        borderRadius: 999,
        background: checked ? "color-mix(in srgb, var(--accent, #4F46E5) 14%, transparent)" : "var(--bg-surface, #FFFFFF)",
        color: checked ? "var(--accent, #4F46E5)" : "var(--text-secondary, #4B5563)",
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ margin: 0 }}
      />
      {label}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Section bodies
// ---------------------------------------------------------------------------

type SourceRow = {
  source: SourceDocument;
  fromJobId: string;
  state: "pending" | "committed";
  ventureSlugOrUnsorted: string | null;
};

function RecentImportsList({
  pending,
  recent,
  onReviewPending,
}: {
  pending: ReadonlyMap<string, PendingVaultImport>;
  recent: ReadonlyArray<RecentVaultImport>;
  onReviewPending: (jobId: string) => void;
}) {
  type Entry = { jobId: string; ts: string; status: "pending" | "committed"; sourceCount: number; draftCount: number };
  const entries: Entry[] = [];
  for (const p of pending.values()) {
    entries.push({
      jobId: p.jobId,
      ts: p.readyAt,
      status: "pending",
      sourceCount: p.sources.length,
      draftCount: p.result.run.drafts.length,
    });
  }
  for (const r of recent) {
    entries.push({
      jobId: r.jobId,
      ts: r.committedAt,
      status: "committed",
      sourceCount: r.pending.sources.length,
      draftCount: r.notesWritten.length,
    });
  }
  entries.sort((a, b) => (a.ts < b.ts ? 1 : -1));

  if (entries.length === 0) {
    return <p style={emptyHint}>No imports yet. Click "Import to vault" to get started.</p>;
  }
  return (
    <ul style={listStyle}>
      {entries.slice(0, 12).map((e) => (
        <li key={e.jobId} style={listItem}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <strong style={{ fontSize: 12, fontFamily: "ui-monospace, monospace" }}>{e.jobId}</strong>{" "}
              <span style={{ fontSize: 11, color: "var(--text-tertiary, #6B7280)" }}>
                · {e.sourceCount} source{e.sourceCount === 1 ? "" : "s"} · {e.draftCount} draft
                {e.draftCount === 1 ? "" : "s"} · {new Date(e.ts).toLocaleString()}
              </span>
            </div>
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                padding: "2px 8px",
                borderRadius: 999,
                background:
                  e.status === "pending"
                    ? "color-mix(in srgb, var(--accent, #4F46E5) 14%, transparent)"
                    : "color-mix(in srgb, #10B981 16%, transparent)",
                color: e.status === "pending" ? "var(--accent, #4F46E5)" : "#065F46",
              }}
            >
              {e.status}
            </span>
            {e.status === "pending" && (
              <button type="button" onClick={() => onReviewPending(e.jobId)} style={linkBtn}>
                Review →
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function ProjectsGrid({
  ventures,
  counts,
  onOpenProject,
}: {
  ventures: Venture[];
  counts: Map<string, number>;
  onOpenProject: (slug: string | "__unsorted__") => void;
}) {
  const unsortedCount = counts.get("__unsorted__") ?? 0;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
        gap: 10,
      }}
    >
      <button
        type="button"
        onClick={() => onOpenProject("__unsorted__")}
        style={projectCard(unsortedCount === 0)}
      >
        <strong style={{ fontSize: 13 }}>Unsorted (Inbox)</strong>
        <span style={cardCount}>
          {unsortedCount} source{unsortedCount === 1 ? "" : "s"}
        </span>
      </button>
      {ventures.map((v) => {
        const count = counts.get(v.slug) ?? 0;
        return (
          <button
            key={v.id}
            type="button"
            onClick={() => onOpenProject(v.slug)}
            style={projectCard(count === 0)}
          >
            <strong style={{ fontSize: 13 }}>{v.name}</strong>
            <span style={cardCount}>
              {count} source{count === 1 ? "" : "s"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SourcesList({
  sources,
  onOpenSource,
}: {
  sources: SourceRow[];
  onOpenSource: (sourceId: string, fromJobId: string) => void;
}) {
  if (sources.length === 0) {
    return <p style={emptyHint}>No sources match the current filters.</p>;
  }
  return (
    <ul style={listStyle}>
      {sources.slice(0, 60).map((row) => (
        <li key={`${row.fromJobId}:${row.source.id}`} style={listItem}>
          <button type="button" onClick={() => onOpenSource(row.source.id, row.fromJobId)} style={linkBtn}>
            <strong style={{ fontSize: 12 }}>{row.source.originalName}</strong>
          </button>{" "}
          <span style={{ fontSize: 11, color: "var(--text-tertiary, #6B7280)" }}>
            · {row.source.sourceType} · {row.source.sourceProvider}
            {row.source.confidence ? ` · ${row.source.confidence}` : ""}
            {" · "}
            {row.state}
          </span>
        </li>
      ))}
      {sources.length > 60 && (
        <li style={{ ...listItem, fontStyle: "italic", color: "var(--text-tertiary, #6B7280)" }}>
          +{sources.length - 60} more — refine the filters to see them.
        </li>
      )}
    </ul>
  );
}

function DraftsList({
  drafts,
  onOpenNote,
}: {
  drafts: Array<{ draft: VaultNoteDraft; fromJobId: string; committed?: string }>;
  onOpenNote: (noteId: string, fromJobId: string) => void;
}) {
  if (drafts.length === 0) {
    return <p style={emptyHint}>No draft notes yet.</p>;
  }
  return (
    <ul style={listStyle}>
      {drafts.slice(0, 40).map(({ draft, fromJobId, committed }) => (
        <li key={`${fromJobId}:${draft.noteId}`} style={listItem}>
          <button type="button" onClick={() => onOpenNote(draft.noteId, fromJobId)} style={linkBtn}>
            <strong style={{ fontSize: 12 }}>{draft.title}</strong>
          </button>{" "}
          <span style={{ fontSize: 11, color: "var(--text-tertiary, #6B7280)" }}>
            · {draft.noteType}
            {draft.confidence ? ` · ${draft.confidence}` : ""}
            {committed ? " · committed" : " · draft"}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ItemsList({
  items,
}: {
  items: Array<{ item: ExtractedItem; fromJobId: string }>;
}) {
  return (
    <ul style={listStyle}>
      {items.slice(0, 30).map(({ item, fromJobId }) => (
        <li key={`${fromJobId}:${item.id}`} style={listItem}>
          <strong style={{ fontSize: 12 }}>{item.title}</strong>{" "}
          <span style={{ fontSize: 11, color: "var(--text-tertiary, #6B7280)" }}>
            · {item.confidence}
          </span>
          <p
            style={{
              margin: "3px 0 0",
              fontSize: 11,
              color: "var(--text-secondary, #4B5563)",
              whiteSpace: "pre-wrap",
            }}
          >
            {truncate(item.content, 200)}
          </p>
        </li>
      ))}
    </ul>
  );
}

function LogsList({
  pending,
  recent,
}: {
  pending: ReadonlyMap<string, PendingVaultImport>;
  recent: ReadonlyArray<RecentVaultImport>;
}) {
  const entries: Array<{ jobId: string; ts: string; level: string; message: string }> = [];
  for (const p of pending.values()) {
    for (const l of p.result.run.logs ?? []) {
      entries.push({ jobId: p.jobId, ts: l.timestamp, level: l.level, message: l.message });
    }
  }
  for (const r of recent) {
    for (const l of r.pending.result.run.logs ?? []) {
      entries.push({ jobId: r.jobId, ts: l.timestamp, level: l.level, message: l.message });
    }
  }
  if (entries.length === 0) {
    return <p style={emptyHint}>No log entries yet.</p>;
  }
  entries.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return (
    <pre
      style={{
        margin: 0,
        padding: "10px 12px",
        background: "#0F172A",
        color: "#E5E7EB",
        borderRadius: 10,
        fontSize: 11,
        lineHeight: 1.5,
        maxHeight: 240,
        overflowY: "auto",
        fontFamily: "ui-monospace, Menlo, monospace",
      }}
    >
      {entries
        .slice(0, 200)
        .map((e) => `[${e.ts}] [${e.jobId}] ${e.level.padEnd(5)} ${e.message}`)
        .join("\n")}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function collectAllSources(
  pending: ReadonlyMap<string, PendingVaultImport>,
  recent: ReadonlyArray<RecentVaultImport>
): SourceRow[] {
  const out: SourceRow[] = [];
  for (const p of pending.values()) {
    for (const proc of p.result.run.perSource) {
      out.push({
        source: proc.source,
        fromJobId: p.jobId,
        state: "pending",
        ventureSlugOrUnsorted: null,
      });
    }
  }
  for (const r of recent) {
    const writtenBySource = new Map<string, string | null>();
    for (const n of r.notesWritten) writtenBySource.set(n.sourceDocumentId, n.ventureSlug);
    for (const proc of r.pending.result.run.perSource) {
      out.push({
        source: proc.source,
        fromJobId: r.jobId,
        state: "committed",
        ventureSlugOrUnsorted: writtenBySource.get(proc.source.id) ?? null,
      });
    }
  }
  return out;
}

function applyFilters(rows: SourceRow[], filters: Filters): SourceRow[] {
  return rows.filter((row) => {
    if (filters.sourceType && row.source.sourceType !== filters.sourceType) return false;
    if (filters.provider && row.source.sourceProvider !== filters.provider) return false;
    if (filters.confidence && row.source.confidence !== filters.confidence) return false;
    if (filters.needsReviewOnly && row.state !== "pending") return false;
    if (filters.unsortedOnly) {
      if (row.state === "committed" && row.ventureSlugOrUnsorted !== null) return false;
    }
    return true;
  });
}

function collectAllItems(
  pending: ReadonlyMap<string, PendingVaultImport>,
  recent: ReadonlyArray<RecentVaultImport>
): Array<{ item: ExtractedItem; fromJobId: string }> {
  const out: Array<{ item: ExtractedItem; fromJobId: string }> = [];
  for (const p of pending.values()) {
    for (const list of Object.values(p.result.run.items)) {
      for (const it of list) out.push({ item: it, fromJobId: p.jobId });
    }
  }
  for (const r of recent) {
    for (const list of Object.values(r.pending.result.run.items)) {
      for (const it of list) out.push({ item: it, fromJobId: r.jobId });
    }
  }
  return out;
}

function collectAllDrafts(
  pending: ReadonlyMap<string, PendingVaultImport>,
  recent: ReadonlyArray<RecentVaultImport>
): Array<{ draft: VaultNoteDraft; fromJobId: string; committed?: string }> {
  const out: Array<{ draft: VaultNoteDraft; fromJobId: string; committed?: string }> = [];
  for (const p of pending.values()) {
    for (const d of p.result.run.drafts ?? []) {
      out.push({ draft: d, fromJobId: p.jobId });
    }
  }
  for (const r of recent) {
    const writtenById = new Map<string, string>();
    for (const n of r.notesWritten) writtenById.set(n.noteId, n.absolutePath);
    for (const d of r.pending.result.run.drafts ?? []) {
      const path = writtenById.get(d.noteId);
      const entry: { draft: VaultNoteDraft; fromJobId: string; committed?: string } = {
        draft: d,
        fromJobId: r.jobId,
      };
      if (path !== undefined) entry.committed = path;
      out.push(entry);
    }
  }
  return out;
}

function countByVenture(
  pending: ReadonlyMap<string, PendingVaultImport>,
  recent: ReadonlyArray<RecentVaultImport>
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of recent) {
    for (const n of r.notesWritten) {
      const key = n.ventureSlug ?? "__unsorted__";
      out.set(key, (out.get(key) ?? 0) + 1);
    }
  }
  // Pending: count each source under the classifier's top suggestion.
  for (const p of pending.values()) {
    for (const proc of p.result.run.perSource) {
      const matches = p.result.run.matches[proc.source.id] ?? [];
      const top = matches[0] ?? null;
      const key = top && top.projectId ? top.projectId : "__unsorted__";
      out.set(key, (out.get(key) ?? 0) + 1);
    }
  }
  return out;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const listStyle: React.CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const listItem: React.CSSProperties = {
  padding: "8px 10px",
  fontSize: 12,
  background: "var(--bg-muted, #F9FAFB)",
  border: "1px solid var(--border-subtle, #E5E7EB)",
  borderRadius: 8,
  marginBottom: 6,
};

const emptyHint: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: "var(--text-tertiary, #6B7280)",
};

const primaryBtn: React.CSSProperties = {
  padding: "8px 14px",
  background: "var(--accent, #4F46E5)",
  color: "var(--accent-fg, #FFFFFF)",
  border: "1px solid transparent",
  borderRadius: 8,
  fontWeight: 700,
  fontSize: 13,
  cursor: "pointer",
};

const ghostBtn: React.CSSProperties = {
  padding: "3px 8px",
  background: "transparent",
  border: "1px solid var(--border-subtle, #E5E7EB)",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 11,
};

const linkBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  cursor: "pointer",
  color: "var(--accent, #4F46E5)",
  textDecoration: "underline",
  fontSize: 12,
  fontWeight: 700,
};

function projectCard(empty: boolean): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: 14,
    border: empty ? "1px dashed var(--border-subtle, #E5E7EB)" : "1px solid var(--border-subtle, #E5E7EB)",
    borderRadius: 12,
    background: empty ? "var(--bg-muted, #F9FAFB)" : "var(--bg-surface, #FFFFFF)",
    color: "var(--text-primary, #0F172A)",
    fontFamily: "inherit",
    textAlign: "left",
    cursor: "pointer",
  };
}

const cardCount: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-tertiary, #6B7280)",
};
