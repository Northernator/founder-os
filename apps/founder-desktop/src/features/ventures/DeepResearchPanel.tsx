import {
  type ResearchBriefing,
  type ResearchChannel,
  type ResearchPlan,
  type ResearchPlanTopic,
  type ResearchTopicStatus,
  safeParseResearchBriefing,
  safeParseResearchPlan,
} from "@founder-os/research-deep-core";
import type { Venture } from "@founder-os/domain";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { joinPath } from "../../lib/venture-io.js";

type DeepResearchState =
  | { kind: "loading" }
  | { kind: "missing" }
  | {
      kind: "ready";
      plan: ResearchPlan;
      briefings: Record<string, ResearchBriefing | null>;
      pasteIns: DeepResearchPasteInRequest[];
    }
  | { kind: "error"; message: string };

type TopicFilter = "all" | "stale" | "failed";
type PasteInStatus = "pending" | "pasted";
type DeepResearchPasteInRequest = {
  channel: ResearchChannel;
  topicSlug: string;
  topicLabel: string;
  promptPath: string;
  responsePath: string;
  statusPath: string;
  status: PasteInStatus;
  responseMarkdown: string;
  updatedAt?: string;
};

const DEEP_DIR = "deep";
const PLAN_FILE = "plan.json";
const BRIEFINGS_DIR = "briefings";

function deepRoot(rootPath: string): string {
  return joinPath(joinPath(rootPath, "00_research"), DEEP_DIR);
}

function planPath(rootPath: string): string {
  return joinPath(deepRoot(rootPath), PLAN_FILE);
}

function briefingJsonPath(rootPath: string, topicSlug: string): string {
  return joinPath(joinPath(deepRoot(rootPath), BRIEFINGS_DIR), `${topicSlug}.json`);
}

function briefingMarkdownPath(rootPath: string, topicSlug: string): string {
  return joinPath(joinPath(deepRoot(rootPath), BRIEFINGS_DIR), `${topicSlug}.md`);
}

function pasteInDir(rootPath: string, channel: ResearchChannel, topicSlug: string): string {
  return joinPath(joinPath(joinPath(deepRoot(rootPath), "paste-in"), channel), topicSlug);
}

function pasteInPromptPath(rootPath: string, channel: ResearchChannel, topicSlug: string): string {
  return joinPath(pasteInDir(rootPath, channel, topicSlug), "prompt.md");
}

function pasteInResponsePath(rootPath: string, channel: ResearchChannel, topicSlug: string): string {
  return joinPath(pasteInDir(rootPath, channel, topicSlug), "response.md");
}

function pasteInStatusPath(rootPath: string, channel: ResearchChannel, topicSlug: string): string {
  return joinPath(pasteInDir(rootPath, channel, topicSlug), "status.json");
}

async function readText(path: string): Promise<string | null> {
  try {
    return await invoke<string>("read_file", { path });
  } catch {
    return null;
  }
}

function openPath(path: string): void {
  invoke("open_path", { path }).catch(() => {});
}

async function writeText(path: string, content: string): Promise<void> {
  await invoke("write_file", { path, content });
}

async function loadDeepResearchState(rootPath: string): Promise<DeepResearchState> {
  const rawPlan = await readText(planPath(rootPath));
  if (!rawPlan) return { kind: "missing" };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawPlan);
  } catch (err) {
    return { kind: "error", message: `plan.json is not valid JSON: ${stringifyErr(err)}` };
  }

  const parsedPlan = safeParseResearchPlan(parsedJson);
  if (!parsedPlan.success) {
    return { kind: "error", message: parsedPlan.error.issues[0]?.message ?? "plan.json is invalid" };
  }

  const briefings: Record<string, ResearchBriefing | null> = {};
  await Promise.all(
    parsedPlan.data.topics.map(async (topic) => {
      const raw = await readText(briefingJsonPath(rootPath, topic.slug));
      if (!raw) {
        briefings[topic.slug] = null;
        return;
      }
      try {
        const parsed = safeParseResearchBriefing(JSON.parse(raw));
        briefings[topic.slug] = parsed.success ? parsed.data : null;
      } catch {
        briefings[topic.slug] = null;
      }
    })
  );

  const pasteIns = await loadPasteIns(rootPath, parsedPlan.data);
  return { kind: "ready", plan: parsedPlan.data, briefings, pasteIns };
}

async function loadPasteIns(rootPath: string, plan: ResearchPlan): Promise<DeepResearchPasteInRequest[]> {
  const channels = plan.channels.filter((channel) => channel === "chatgpt-sub" || channel === "paste-in");
  const out: DeepResearchPasteInRequest[] = [];

  await Promise.all(
    plan.topics.flatMap((topic) =>
      channels.map(async (channel) => {
        const promptPath = pasteInPromptPath(rootPath, channel, topic.slug);
        const prompt = await readText(promptPath);
        if (!prompt) return;

        const statusPath = pasteInStatusPath(rootPath, channel, topic.slug);
        const responsePath = pasteInResponsePath(rootPath, channel, topic.slug);
        const responseMarkdown = (await readText(responsePath)) ?? "";
        const rawStatus = await readText(statusPath);
        const parsedStatus = parsePasteStatus(rawStatus);
        out.push({
          channel,
          topicSlug: topic.slug,
          topicLabel: topic.label,
          promptPath,
          responsePath,
          statusPath,
          status: responseMarkdown.trim().length > 0 ? "pasted" : parsedStatus.status,
          responseMarkdown,
          updatedAt: parsedStatus.updatedAt,
        });
      })
    )
  );

  return out.sort((a, b) => a.topicLabel.localeCompare(b.topicLabel));
}

export function DeepResearchPanel({ venture }: { venture: Venture }) {
  const [state, setState] = useState<DeepResearchState>({ kind: "loading" });
  const [filter, setFilter] = useState<TopicFilter>("all");

  const refresh = useCallback(() => {
    let alive = true;
    setState({ kind: "loading" });
    loadDeepResearchState(venture.rootPath)
      .then((next) => {
        if (alive) setState(next);
      })
      .catch((err) => {
        if (alive) setState({ kind: "error", message: stringifyErr(err) });
      });
    return () => {
      alive = false;
    };
  }, [venture.rootPath]);

  useEffect(() => refresh(), [refresh]);

  if (state.kind === "loading") {
    return <PanelShell title="Deep research vault" right={<TinyButton onClick={refresh}>Refresh</TinyButton>}>Loading vault...</PanelShell>;
  }

  if (state.kind === "missing") {
    return (
      <PanelShell title="Deep research vault" right={<TinyButton onClick={refresh}>Refresh</TinyButton>}>
        <span style={{ color: "var(--text-tertiary)", fontSize: 12 }}>
          No vault yet. Running the research stage will create <code>00_research/deep/plan.json</code>.
        </span>
      </PanelShell>
    );
  }

  if (state.kind === "error") {
    return (
      <PanelShell title="Deep research vault" right={<TinyButton onClick={refresh}>Refresh</TinyButton>}>
        <span style={{ color: "var(--danger)", fontSize: 12 }}>{state.message}</span>
      </PanelShell>
    );
  }

  const counts = countStatuses(state.plan.topics);
  const topics = state.plan.topics.filter((topic) => {
    if (filter === "stale") return topic.status === "stale";
    if (filter === "failed") return topic.status === "failed";
    return true;
  });

  return (
    <PanelShell
      title="Deep research vault"
      right={
        <>
          <DeepResearchChannelBadge plan={state.plan} />
          <TinyButton onClick={refresh}>Refresh</TinyButton>
        </>
      }
    >
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <StatusPill label="ready" count={counts.ready} status="ready" />
        <StatusPill label="running" count={counts.running} status="running" />
        <StatusPill label="stale" count={counts.stale} status="stale" />
        <StatusPill label="failed" count={counts.failed} status="failed" />
        <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>
          All
        </FilterButton>
        <FilterButton active={filter === "stale"} onClick={() => setFilter("stale")}>
          Stale
        </FilterButton>
        <FilterButton active={filter === "failed"} onClick={() => setFilter("failed")}>
          Failed
        </FilterButton>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <PasteInGateList requests={state.pasteIns} onSaved={refresh} />
        {topics.length === 0 && (
          <span style={{ color: "var(--text-tertiary)", fontSize: 12 }}>No topics match this filter.</span>
        )}
        {topics.map((topic) => (
          <TopicRow
            key={topic.slug}
            topic={topic}
            briefing={state.briefings[topic.slug] ?? null}
            ventureRoot={venture.rootPath}
          />
        ))}
      </div>
    </PanelShell>
  );
}

export function DeepResearchHeaderBadge({ venture }: { venture: Venture }) {
  const [plan, setPlan] = useState<ResearchPlan | null>(null);

  useEffect(() => {
    let alive = true;
    readText(planPath(venture.rootPath))
      .then((raw) => {
        if (!alive || !raw) return;
        try {
          const parsed = safeParseResearchPlan(JSON.parse(raw));
          if (parsed.success) setPlan(parsed.data);
        } catch {
          setPlan(null);
        }
      })
      .catch(() => setPlan(null));
    return () => {
      alive = false;
    };
  }, [venture.rootPath]);

  if (!plan) return null;
  return <DeepResearchChannelBadge plan={plan} />;
}

function PasteInGateList({
  requests,
  onSaved,
}: {
  requests: DeepResearchPasteInRequest[];
  onSaved: () => void;
}) {
  const pending = requests.filter((req) => req.status === "pending");
  if (pending.length === 0) return null;

  return (
    <div
      style={{
        border: "1px solid #FDE68A",
        borderRadius: 6,
        background: "#FFFBEB",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ fontSize: 13, color: "#92400E", flex: 1 }}>Paste-in responses needed</strong>
        <span style={{ fontSize: 11, color: "#B45309" }}>{pending.length} pending</span>
      </div>
      {pending.map((req) => (
        <PasteInGateRow key={`${req.channel}:${req.topicSlug}`} req={req} onSaved={onSaved} />
      ))}
    </div>
  );
}

function PasteInGateRow({
  req,
  onSaved,
}: {
  req: DeepResearchPasteInRequest;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(req.responseMarkdown);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(req.responseMarkdown), [req.responseMarkdown]);

  async function saveResponse() {
    if (draft.trim().length === 0 || saving) return;
    setSaving(true);
    try {
      await writeText(req.responsePath, draft.trimEnd() + "\n");
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        borderTop: "1px solid #FDE68A",
        paddingTop: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <ChannelPill channel={req.channel} />
        <span style={{ fontSize: 12, fontWeight: 700, color: "#78350F" }}>{req.topicLabel}</span>
        <span style={{ fontSize: 11, color: "#B45309" }}>{req.updatedAt ? formatDate(req.updatedAt) : req.topicSlug}</span>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <TinyButton onClick={() => openPath(req.promptPath)}>Open prompt</TinyButton>
        <TinyButton onClick={() => openPath(req.responsePath)}>Open response file</TinyButton>
      </div>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Paste the full ChatGPT / LLM deep research response here."
        style={{
          minHeight: 96,
          resize: "vertical",
          border: "1px solid #FDE68A",
          borderRadius: 6,
          padding: 10,
          fontSize: 12,
          lineHeight: 1.5,
          color: "var(--text-primary)",
          background: "var(--bg-panel)",
          fontFamily: "inherit",
        }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={saveResponse}
          disabled={saving || draft.trim().length === 0}
          style={{
            padding: "6px 12px",
            border: "1px solid #FDE68A",
            borderRadius: 6,
            background: draft.trim().length === 0 ? "var(--bg-elevated)" : "#FEF3C7",
            color: draft.trim().length === 0 ? "var(--text-muted)" : "#92400E",
            fontSize: 12,
            fontWeight: 800,
            cursor: saving || draft.trim().length === 0 ? "not-allowed" : "pointer",
          }}
        >
          {saving ? "Saving..." : "Save response"}
        </button>
      </div>
    </div>
  );
}

function TopicRow({
  topic,
  briefing,
  ventureRoot,
}: {
  topic: ResearchPlanTopic;
  briefing: ResearchBriefing | null;
  ventureRoot: string;
}) {
  const sourceCount = briefing?.sources.length ?? 0;
  const sectionCount = briefing?.sections.length ?? 0;
  const channels = briefing?.channelsUsed ?? [];
  const generated = briefing?.generatedAt ?? topic.lastRunAt;

  return (
    <details
      style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        background: "var(--bg-elevated)",
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          padding: "10px 12px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          listStyle: "none",
        }}
      >
        <StatusDot status={topic.status} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>
            {topic.label}
          </span>
          <span style={{ display: "block", fontSize: 11, color: "var(--text-tertiary)" }}>
            {topic.slug} · {topic.questions.length} questions · {sectionCount} sections · {sourceCount} sources
          </span>
        </span>
        <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
          {generated ? formatDate(generated) : topic.status}
        </span>
      </summary>
      <div style={{ padding: "0 12px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
        {topic.lastError && (
          <div style={{ fontSize: 12, color: "var(--danger)", wordBreak: "break-word" }}>{topic.lastError}</div>
        )}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(channels.length > 0 ? channels : ["paste-in" as const]).map((channel) => (
            <ChannelPill key={channel} channel={channel} />
          ))}
          {topic.consumers.map((consumer) => (
            <span key={consumer} style={consumerPillStyle}>
              {consumer}
            </span>
          ))}
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-secondary)", fontSize: 12 }}>
          {topic.questions.map((question) => (
            <li key={question.id}>
              <span style={{ color: "var(--text-primary)" }}>{question.question}</span>{" "}
              <span style={{ color: "var(--text-muted)" }}>
                [{question.angle}, {question.priority}]
              </span>
            </li>
          ))}
        </ul>
        {briefing?.disagreements.length ? (
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            <strong>Disagreements:</strong> {briefing.disagreements.slice(0, 2).join(" ")}
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <TinyButton onClick={() => openPath(briefingMarkdownPath(ventureRoot, topic.slug))}>
            Open briefing
          </TinyButton>
          <TinyButton onClick={() => openPath(briefingJsonPath(ventureRoot, topic.slug))}>
            Open JSON
          </TinyButton>
        </div>
      </div>
    </details>
  );
}

function PanelShell({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h5 style={{ margin: 0, fontSize: 13, fontWeight: 800, color: "var(--text-primary)", flex: 1 }}>
          {title}
        </h5>
        {right && <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>{right}</div>}
      </div>
      {children}
    </div>
  );
}

function DeepResearchChannelBadge({ plan }: { plan: ResearchPlan }) {
  const status = useMemo(() => {
    const channels = plan.channels;
    if (channels.length === 0) return { color: "#6B7280", label: "Deep research: no channels" };
    const apiOnly = channels.every((channel) => channel.endsWith("-api") || channel === "research_py");
    const degraded = channels.includes("paste-in") || channels.length < 3;
    return {
      color: apiOnly ? "#DC2626" : degraded ? "#D97706" : "#059669",
      label: `Deep research: ${channels.join(", ")}`,
    };
  }, [plan.channels]);

  return (
    <span
      title={status.label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 8px",
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        fontSize: 11,
        fontWeight: 700,
        color: "var(--text-secondary)",
        background: "var(--bg-elevated)",
        whiteSpace: "nowrap",
        maxWidth: 360,
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 99, background: status.color }} />
      {status.label}
    </span>
  );
}

function StatusPill({
  label,
  count,
  status,
}: {
  label: string;
  count: number;
  status: ResearchTopicStatus;
}) {
  return (
    <span style={{ ...pillStyleFor(status), padding: "3px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700 }}>
      {label}: {count}
    </span>
  );
}

function StatusDot({ status }: { status: ResearchTopicStatus }) {
  const style = pillStyleFor(status);
  return <span style={{ width: 9, height: 9, borderRadius: 99, background: style.color, flex: "0 0 auto" }} />;
}

function ChannelPill({ channel }: { channel: ResearchChannel }) {
  return <span style={channelPillStyle}>{channel}</span>;
}

function TinyButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "4px 8px",
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        background: "var(--bg-panel)",
        color: "var(--text-secondary)",
        fontSize: 11,
        fontWeight: 700,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "3px 8px",
        borderRadius: 6,
        border: `1px solid ${active ? "var(--accent-soft)" : "var(--border-subtle)"}`,
        background: active ? "var(--accent-soft)" : "var(--bg-panel)",
        color: active ? "var(--accent-hover)" : "var(--text-secondary)",
        fontSize: 11,
        fontWeight: 700,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function countStatuses(topics: ResearchPlanTopic[]): Record<ResearchTopicStatus, number> {
  return topics.reduce<Record<ResearchTopicStatus, number>>(
    (acc, topic) => {
      acc[topic.status] += 1;
      return acc;
    },
    { pending: 0, running: 0, ready: 0, stale: 0, failed: 0 }
  );
}

function pillStyleFor(status: ResearchTopicStatus): React.CSSProperties {
  if (status === "ready") return { background: "#ECFDF5", color: "#047857", border: "1px solid #A7F3D0" };
  if (status === "running") return { background: "#EFF6FF", color: "#2563EB", border: "1px solid #BFDBFE" };
  if (status === "stale") return { background: "#FEF3C7", color: "#B45309", border: "1px solid #FDE68A" };
  if (status === "failed") return { background: "#FEF2F2", color: "#B91C1C", border: "1px solid #FECACA" };
  return { background: "var(--bg-panel)", color: "var(--text-muted)", border: "1px solid var(--border-subtle)" };
}

const channelPillStyle: React.CSSProperties = {
  padding: "2px 7px",
  borderRadius: 4,
  border: "1px solid var(--border-subtle)",
  color: "var(--text-secondary)",
  background: "var(--bg-panel)",
  fontSize: 11,
  fontWeight: 700,
};

const consumerPillStyle: React.CSSProperties = {
  ...channelPillStyle,
  color: "var(--text-muted)",
  fontWeight: 600,
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function parsePasteStatus(raw: string | null): { status: PasteInStatus; updatedAt?: string } {
  if (!raw) return { status: "pending" };
  try {
    const parsed = JSON.parse(raw) as { status?: unknown; updatedAt?: unknown };
    return {
      status: parsed.status === "pasted" ? "pasted" : "pending",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
    };
  } catch {
    return { status: "pending" };
  }
}
