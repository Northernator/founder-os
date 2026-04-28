/**
 * Agent Registry — single source of truth for the CLI agents
 * Founder Cowork knows how to launch. Patterned on Orca's TUI_AGENT_CONFIG
 * (see reference/orca/src/shared/tui-agent-config.ts for prior art).
 *
 * Adding a new agent: add its AgentId, add an entry here, and append to
 * AGENT_ORDER. Runner, account manager, and Mission Control UI all key
 * off this file — no other changes required for basic support.
 */

export type AgentId = "claude" | "codex" | "gemini" | "ollama" | "opencode";

/**
 * How the prompt is injected into the agent CLI:
 *  - 'argv'       — passed as the final positional argument
 *  - 'stdin'      — piped to stdin after spawn
 *  - 'flag-prompt'— passed via --prompt flag
 *  - 'http'       — sent as an HTTP body (Ollama, Gemini REST fallback)
 */
export type PromptInjectionMode = "argv" | "stdin" | "flag-prompt" | "http";

/**
 * How the agent's credentials are managed:
 *  - 'managed-account' — Founder Cowork owns per-account auth files and
 *    materializes the selected account before each launch (Codex pattern;
 *    see Orca codex-account-switching-design.md).
 *  - 'cli-login' — the CLI manages its own auth; Founder Cowork only detects
 *    whether a login exists (Claude Code pattern).
 *  - 'api-key' — a raw API key is stored in VS Code SecretStorage and passed
 *    as an env var at spawn time (Gemini when CLI is unavailable).
 *  - 'none' — local, unauthenticated (Ollama).
 */
export type AuthStyle = "managed-account" | "cli-login" | "api-key" | "none";

export interface AgentDefinition {
  id: AgentId;
  label: string;
  /** Emoji used in list UIs. Mission Control also maps to codicons. */
  icon: string;
  /** Binary looked up on PATH for health checks. */
  detectCmd: string;
  /** Binary invoked by AgentRunner (usually the same as detectCmd). */
  launchCmd: string;
  /** Process name for activity detection (ps -eo comm). */
  expectedProcess: string;
  promptInjection: PromptInjectionMode;
  authStyle: AuthStyle;
  /** Path (may contain ~) where the agent keeps its config/auth. */
  configHome?: string;
  /** Relative to configHome; file swapped per-account for managed-account agents. */
  authFile?: string;
  /** Env var names the runner should set per-PTY for this agent. */
  envOverrides?: string[];
}

export const AGENT_REGISTRY: Record<AgentId, AgentDefinition> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    icon: "🟣",
    detectCmd: "claude",
    launchCmd: "claude",
    expectedProcess: "claude",
    promptInjection: "argv",
    authStyle: "cli-login",
    configHome: "~/.claude",
  },
  codex: {
    id: "codex",
    label: "Codex",
    icon: "🔵",
    detectCmd: "codex",
    launchCmd: "codex",
    expectedProcess: "codex",
    promptInjection: "argv",
    authStyle: "managed-account",
    configHome: "~/.codex",
    authFile: "auth.json",
    envOverrides: ["CODEX_HOME"],
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    icon: "🟡",
    detectCmd: "gemini",
    launchCmd: "gemini",
    expectedProcess: "gemini",
    promptInjection: "argv",
    authStyle: "api-key",
    envOverrides: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    icon: "🟢",
    detectCmd: "opencode",
    launchCmd: "opencode",
    expectedProcess: "opencode",
    promptInjection: "flag-prompt",
    authStyle: "cli-login",
    envOverrides: ["OPENCODE_CONFIG_DIR"],
  },
  ollama: {
    id: "ollama",
    label: "Ollama",
    icon: "🦙",
    detectCmd: "ollama",
    launchCmd: "ollama",
    expectedProcess: "ollama",
    promptInjection: "http",
    authStyle: "none",
  },
};

/** Display order for Mission Control (Claude and Codex surfaced first). */
export const AGENT_ORDER: AgentId[] = ["claude", "codex", "gemini", "opencode", "ollama"];

export function getAgent(id: AgentId): AgentDefinition {
  return AGENT_REGISTRY[id];
}

export function listAgents(): AgentDefinition[] {
  return AGENT_ORDER.map((id) => AGENT_REGISTRY[id]);
}

export function isAgentId(value: string): value is AgentId {
  return value in AGENT_REGISTRY;
}
