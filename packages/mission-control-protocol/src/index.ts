/**
 * Mission Control protocol - the wire format between the VS Code extension
 * host and the React webview. Both sides import from this package, so
 * messages can never drift.
 */

import type { AgentId } from "@founder-os/agent-registry";

export const MC_PROTOCOL_VERSION = 1;

export interface AgentHealth {
  healthy: boolean;
  hint?: string;
}

export type AgentHealthMap = Partial<Record<AgentId, AgentHealth>>;

export interface AgentSummary {
  id: AgentId;
  label: string;
  icon: string;
  authStyle: "managed-account" | "cli-login" | "api-key" | "none";
  promptInjection: "argv" | "stdin" | "flag-prompt" | "http";
}

export interface SessionSummary {
  id: string;
  agentId: AgentId;
  agentLabel: string;
  branch: string;
  worktreePath: string;
  status: "running" | "exited" | "killed";
  pid: number;
  startedAt: number;
}

export interface InitState {
  protocolVersion: typeof MC_PROTOCOL_VERSION;
  extensionVersion: string;
  agents: AgentSummary[];
  agentHealth: AgentHealthMap;
  sessions: SessionSummary[];
  ventureRoot: string | null;
}

export interface GitStatusResponse {
  branch: string | null;
  ahead: number;
  behind: number;
  tracking: string | null;
  changedFiles: { path: string; status: string }[];
  isClean: boolean;
  hasUncommitted: boolean;
}

export interface GitCommitResponse {
  commitSha: string;
  pushed: boolean;
  pushHint?: string;
}

export interface GitCreatePrResponse {
  url: string;
}

export interface OllamaModelInfo {
  name: string;
  modifiedAt?: string;
  sizeBytes?: number;
}

export interface OllamaListModelsResponse {
  baseUrl: string;
  models: OllamaModelInfo[];
}

export interface OllamaRunResponse {
  model: string;
  response: string;
  totalDurationMs?: number;
}

export type SkillSource = "workspace" | "user" | "bundled";

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  version?: string;
  source: SkillSource;
  filePath: string;
  modifiedAt: number;
}

export interface SkillsListResponse {
  skills: SkillSummary[];
}

export interface SkillBodyResponse {
  id: string;
  source: SkillSource;
  frontmatter: Record<string, string>;
  body: string;
}

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryEntry {
  id: string;
  name: string;
  description: string;
  type: MemoryType;
  modifiedAt: number;
  bytes: number;
}

export interface MemoryEntryBody extends MemoryEntry {
  body: string;
}

export interface MemoryListResponse {
  entries: MemoryEntry[];
}

export interface MemorySaveInput {
  id?: string;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

export interface VaultDoc {
  id: string;
  title: string;
  tags: string[];
  modifiedAt: number;
  bytes: number;
}

export interface VaultDocBody extends VaultDoc {
  body: string;
}

export interface VaultListResponse {
  docs: VaultDoc[];
}

export interface VaultSaveInput {
  id?: string;
  title: string;
  tags: string[];
  body: string;
}

export interface ApproveResponse {
  commitSha: string;
}

export interface SessionsStatsResponse {
  total: number;
  running: number;
  exited: number;
  killed: number;
}

// Accounts (Phase 3.2)

export interface AccountSummary {
  id: string;
  agentId: AgentId;
  label: string;
  notes?: string;
  createdAt: string;
  source: "imported" | "captured" | "system-default";
}

export interface AccountsListResponse {
  /** Map of agentId -> accounts list. */
  byAgent: Partial<Record<AgentId, AccountSummary[]>>;
  /** Map of agentId -> active accountId (or null if none chosen). */
  active: Partial<Record<AgentId, string | null>>;
}

export interface AccountSaveInput {
  agentId: AgentId;
  /** Empty/undefined = create a new id from the label. */
  id?: string;
  label: string;
  notes?: string;
  /** Raw auth.json blob the user pasted/imported. */
  authJson: string;
  source?: "imported" | "captured";
}


// Truth tab (Phase 1b.4)

export type HandoffRunStatus =
  | "accepted"
  | "running"
  | "success"
  | "failed"
  | "cancelled";

export interface TruthRunResponse {
  runId: string;
  status: HandoffRunStatus;
  /** Contents of TRUTH.md after the run, if it landed on disk. */
  body?: string;
  /** Relative path of the produced TRUTH.md (POSIX). */
  bodyPath?: string;
  /** Other artifacts the runner produced (relative POSIX paths). */
  producedArtifacts?: string[];
  summary?: string;
  error?: string;
}

// Host -> Webview

export type HostToWebviewMessage =
  | { type: "init"; state: InitState }
  | { type: "agents:health"; health: AgentHealthMap }
  | { type: "sessions:update"; sessions: SessionSummary[] }
  | { type: "session:started"; session: SessionSummary }
  | { type: "session:exited"; sessionId: string; exitCode: number }
  | { type: "ventureRoot:changed"; ventureRoot: string | null }
  | { type: "response"; requestId: string; ok: true; result: unknown }
  | { type: "response"; requestId: string; ok: false; error: string }
  | { type: "toast"; level: "info" | "warn" | "error"; message: string };

// Webview -> Host

interface BaseWebviewRequest {
  requestId?: string;
}

export type WebviewToHostMessage =
  | (BaseWebviewRequest & { type: "ready" })
  | (BaseWebviewRequest & { type: "refresh:init" })

  | (BaseWebviewRequest & {
      type: "session:spawn";
      agentId: AgentId;
      prompt: string;
      branchSuffix?: string;
    })
  | (BaseWebviewRequest & {
      type: "session:orchestrate";
      pmAgentId: AgentId;
      executorAgentId: AgentId;
      goal: string;
    })
  | (BaseWebviewRequest & { type: "session:show"; sessionId: string })
  | (BaseWebviewRequest & { type: "session:kill"; sessionId: string })

  | (BaseWebviewRequest & { type: "agents:rerunPreflight" })
  | (BaseWebviewRequest & { type: "settings:open"; query?: string })
  | (BaseWebviewRequest & { type: "ventureRoot:pick" })

  | (BaseWebviewRequest & { type: "github:status" })
  | (BaseWebviewRequest & { type: "github:createBranch"; name: string })
  | (BaseWebviewRequest & { type: "github:commitAndPush"; message: string })
  | (BaseWebviewRequest & {
      type: "github:createPR";
      title: string;
      body: string;
    })

  | (BaseWebviewRequest & { type: "ollama:listModels" })
  | (BaseWebviewRequest & {
      type: "ollama:run";
      model: string;
      prompt: string;
    })

  | (BaseWebviewRequest & { type: "skills:list" })
  | (BaseWebviewRequest & {
      type: "skills:read";
      id: string;
      source: SkillSource;
    })

  | (BaseWebviewRequest & { type: "memory:list" })
  | (BaseWebviewRequest & { type: "memory:read"; id: string })
  | (BaseWebviewRequest & { type: "memory:save"; entry: MemorySaveInput })
  | (BaseWebviewRequest & { type: "memory:delete"; id: string })
  | (BaseWebviewRequest & { type: "memory:saveCurrent" })

  | (BaseWebviewRequest & { type: "vault:list" })
  | (BaseWebviewRequest & { type: "vault:read"; id: string })
  | (BaseWebviewRequest & { type: "vault:save"; doc: VaultSaveInput })
  | (BaseWebviewRequest & { type: "vault:delete"; id: string })

  // Truth + Explain (Phase 1b.4)
  | (BaseWebviewRequest & {
      type: "truth:run";
      target: string;
      scopeNotes?: string;
    })
  | (BaseWebviewRequest & {
      type: "explain:run";
      selection: string;
      question?: string;
      agentId?: AgentId;
    })


  // Accounts (Phase 3.2)
  | (BaseWebviewRequest & { type: "accounts:list" })
  | (BaseWebviewRequest & { type: "accounts:save"; input: AccountSaveInput })
  | (BaseWebviewRequest & { type: "accounts:delete"; agentId: AgentId; id: string })
  | (BaseWebviewRequest & {
      type: "accounts:setActive";
      agentId: AgentId;
      /** null clears the active account for that agent. */
      id: string | null;
    })

  // PM workflow (Phase 1b.5)
  | (BaseWebviewRequest & { type: "task:analyzeRepo"; agentId?: AgentId })
  | (BaseWebviewRequest & { type: "task:planTask"; goal: string; agentId?: AgentId })
  | (BaseWebviewRequest & {
      type: "task:executeTask";
      executorAgentId: AgentId;
    })
  | (BaseWebviewRequest & { type: "task:reviewExecution"; agentId?: AgentId })
  | (BaseWebviewRequest & { type: "task:approve" })
  | (BaseWebviewRequest & {
      type: "task:requestRevision";
      executorAgentId: AgentId;
      notes: string;
    })
  | (BaseWebviewRequest & { type: "task:askGemini"; question: string })
  | (BaseWebviewRequest & {
      type: "task:askGeminiDiff";
      question: string;
    })
  | (BaseWebviewRequest & { type: "stats:refresh" });

export function isHostMessage(value: unknown): value is HostToWebviewMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  );
}

export function isWebviewMessage(value: unknown): value is WebviewToHostMessage {
  return isHostMessage(value);
}
