/**
 * <SocialPostLogPanel> -- slice 6 of the SOCIAL-MODULE follow-up arc.
 *
 * Reads the venture's `13_social/posts/*.result.json` artifacts via the
 * existing `list_dir_recursive` + `read_file` Tauri commands (same
 * pattern as artifacts-scan.ts) and renders the last N posts plus a
 * per-platform success-rate summary.
 *
 * The panel is intentionally read-only -- it does NOT trigger reposts,
 * delete posts, or expose moderation actions. The result-JSON shape is
 * authoritative (matches SocialResultSchema in social-core), so we re-
 * parse on the way in and tolerate unknown rows.
 *
 * Empty state: a venture with zero posts shows a small "No posts yet"
 * line + a link to the existing "Open posts log" affordance in
 * SocialActions. Future ventures that have accrued a few will see real
 * rows.
 */
import {
  parseSocialResult,
  SocialPlatformSchema,
  type SocialPlatform,
  type SocialResult,
  type SocialResultRow,
} from "@founder-os/social-core";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

const POSTS_DIR_SEGMENT = "13_social/posts";
const DEFAULT_LIMIT = 5;

type RustDirEntry = {
  path: string;
  isDir: boolean;
  sizeBytes: number;
  modifiedAt: string | null;
};

export type SocialPostLogPanelProps = {
  ventureRoot: string;
  /** Most-recent N posts to render. Default 5. */
  limit?: number;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; reason: string }
  | { kind: "ready"; entries: LoadedEntry[]; perPlatform: PlatformAgg[] };

type LoadedEntry = {
  absolutePath: string;
  filename: string;
  result: SocialResult;
};

type PlatformAgg = {
  platform: SocialPlatform;
  total: number;
  successful: number;
  rate: number;
};

export function SocialPostLogPanel(props: SocialPostLogPanelProps) {
  const limit = props.limit ?? DEFAULT_LIMIT;
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const reload = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const root = props.ventureRoot.replace(/\\/g, "/").replace(/\/+$/, "");
      const postsDir = `${root}/${POSTS_DIR_SEGMENT}`;
      let entries: RustDirEntry[] = [];
      try {
        entries = await invoke<RustDirEntry[]>("list_dir_recursive", {
          path: postsDir,
        });
      } catch {
        // Directory doesn't exist yet (or other IO failure). Treat as
        // empty rather than error -- a fresh venture hasn't posted yet.
        setState({ kind: "empty" });
        return;
      }

      const jsonFiles = entries
        .filter((e) => !e.isDir && /\.result\.json$/i.test(e.path))
        .sort((a, b) => {
          // Newest first by mtime; fall back to path so the sort is stable
          // even when two files share a timestamp (round-second writes).
          const ma = a.modifiedAt ?? "";
          const mb = b.modifiedAt ?? "";
          if (ma !== mb) return mb.localeCompare(ma);
          return b.path.localeCompare(a.path);
        });

      if (jsonFiles.length === 0) {
        setState({ kind: "empty" });
        return;
      }

      const loaded: LoadedEntry[] = [];
      // Aggregate across ALL posts on disk -- the limit only governs how
      // many we render, not how many feed the per-platform success rate.
      // Real ventures will want the rate to reflect the whole history.
      const aggMap = new Map<SocialPlatform, { total: number; success: number }>();

      for (const file of jsonFiles) {
        let raw: string;
        try {
          raw = await invoke<string>("read_file", { path: file.path });
        } catch {
          continue;
        }
        let parsed: SocialResult;
        try {
          const json = JSON.parse(raw);
          parsed = parseSocialResult(json);
        } catch {
          continue;
        }
        for (const row of parsed.rows) {
          const cur = aggMap.get(row.platform) ?? { total: 0, success: 0 };
          cur.total += 1;
          if (row.success) cur.success += 1;
          aggMap.set(row.platform, cur);
        }
        if (loaded.length < limit) {
          loaded.push({
            absolutePath: file.path,
            filename: file.path.split(/[\\/]/).pop() ?? file.path,
            result: parsed,
          });
        }
      }

      if (loaded.length === 0) {
        setState({ kind: "empty" });
        return;
      }

      const perPlatform: PlatformAgg[] = [];
      for (const platform of SocialPlatformSchema.options) {
        const agg = aggMap.get(platform);
        if (!agg) continue;
        perPlatform.push({
          platform,
          total: agg.total,
          successful: agg.success,
          rate: agg.total > 0 ? agg.success / agg.total : 0,
        });
      }
      perPlatform.sort((a, b) => b.total - a.total);

      setState({ kind: "ready", entries: loaded, perPlatform });
    } catch (err) {
      setState({
        kind: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }, [props.ventureRoot, limit]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div
      style={{
        padding: 12,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>
          Recent posts
        </span>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={state.kind === "loading"}
          style={{
            padding: "3px 8px",
            fontSize: 11,
            fontWeight: 600,
            background: "transparent",
            border: "1px solid var(--border-subtle)",
            color: "var(--text-secondary)",
            borderRadius: 4,
            cursor: state.kind === "loading" ? "default" : "pointer",
          }}
        >
          {state.kind === "loading" ? "Loading..." : "Reload"}
        </button>
      </div>

      {state.kind === "loading" && (
        <PanelHint>Loading recent posts...</PanelHint>
      )}
      {state.kind === "empty" && (
        <PanelHint>No posts yet. Compose one above to populate this panel.</PanelHint>
      )}
      {state.kind === "error" && (
        <PanelHint tone="danger">Could not load posts: {state.reason}</PanelHint>
      )}
      {state.kind === "ready" && (
        <>
          <PerPlatformBar perPlatform={state.perPlatform} />
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
            {state.entries.map((entry) => (
              <PostRow key={entry.absolutePath} entry={entry} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function PerPlatformBar({ perPlatform }: { perPlatform: PlatformAgg[] }) {
  if (perPlatform.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {perPlatform.map((p) => {
        const pct = Math.round(p.rate * 100);
        const tone =
          p.rate >= 0.9
            ? "var(--accent-hover)"
            : p.rate >= 0.5
              ? "var(--text-primary)"
              : "var(--danger, #c46161)";
        return (
          <span
            key={p.platform}
            title={`${p.successful}/${p.total} successful on ${p.platform}`}
            style={{
              padding: "3px 8px",
              fontSize: 11,
              fontWeight: 600,
              background: "var(--bg-base)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 999,
              color: tone,
            }}
          >
            {p.platform}: {pct}% ({p.successful}/{p.total})
          </span>
        );
      })}
    </div>
  );
}

function PostRow({ entry }: { entry: LoadedEntry }) {
  const success = entry.result.rows.filter((r) => r.success).length;
  const total = entry.result.rows.length;
  const when = entry.result.postedAt;
  const firstFail = entry.result.rows.find((r) => !r.success);
  return (
    <li
      style={{
        padding: 8,
        background: "var(--bg-base)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11 }}>
        <code style={{ color: "var(--text-secondary)" }}>{entry.filename}</code>
        <span
          style={{
            fontWeight: 700,
            color:
              success === total
                ? "var(--accent-hover)"
                : success === 0
                  ? "var(--danger, #c46161)"
                  : "var(--text-primary)",
          }}
        >
          {success}/{total}
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {entry.result.rows.map((row, idx) => (
          <PlatformChip key={`${row.platform}-${idx}`} row={row} />
        ))}
      </div>
      <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
        {when} · {entry.result.backend}
        {firstFail?.error ? ` · "${firstFail.error.slice(0, 80)}"` : ""}
      </div>
    </li>
  );
}

function PlatformChip({ row }: { row: SocialResultRow }) {
  return (
    <span
      title={
        row.success
          ? row.postUrl ?? `posted to ${row.platform}`
          : row.error ?? `${row.platform}: failed`
      }
      style={{
        padding: "2px 6px",
        fontSize: 10,
        fontWeight: 600,
        background: row.success ? "var(--accent-soft)" : "var(--bg-elevated)",
        color: row.success ? "var(--accent-hover)" : "var(--danger, #c46161)",
        border: `1px solid ${row.success ? "var(--accent-soft)" : "var(--border-subtle)"}`,
        borderRadius: 999,
      }}
    >
      {row.platform} {row.success ? "✓" : "✗"}
    </span>
  );
}

function PanelHint({ children, tone }: { children: React.ReactNode; tone?: "danger" }) {
  return (
    <p
      style={{
        margin: 0,
        fontSize: 12,
        color: tone === "danger" ? "var(--danger, #c46161)" : "var(--text-muted)",
      }}
    >
      {children}
    </p>
  );
}
