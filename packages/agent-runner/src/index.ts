/**
 * AgentRunner — node-pty wrapper that spawns a CLI agent inside a
 * pseudo-terminal and exposes a clean session interface.
 *
 * Phase 3.2 update: optional AccountManager integration. When the caller
 * passes both `accountManager` and `account` AND the agent is a
 * managed-account agent, the runner:
 *   1. Acquires the per-agent serialisation mutex via runSerialised().
 *   2. Materialises the chosen account's auth.json into the agent's
 *      configHome (Orca CodexRuntimeHomeService pattern).
 *   3. Spawns pty.
 *   4. Holds the mutex until the session exits, then restores the previous
 *      auth state (system-default snapshot or whatever was there before).
 *
 * Cross-agent spawns parallelise (one mutex per agent). Same-agent spawns
 * queue: a hung Codex session blocks the next Codex spawn until it exits.
 * That's intentional - two Codex sessions sharing one auth.json file with
 * different account creds is unsafe (the CLI re-reads on every API call).
 */

import type * as nodePty from "node-pty";
import type {
  AgentDefinition,
  AgentId,
} from "@founder-os/agent-registry";
import type { AccountManager } from "@founder-os/agent-accounts";

// ──────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────

export interface SpawnOptions {
  agent: AgentDefinition;
  prompt: string;
  cwd: string;
  /** Account id whose auth.json should be materialised before spawn. */
  account?: string;
  /** Required if `account` is set on a managed-account agent. */
  accountManager?: AccountManager;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  oneShot?: boolean;
}

export interface AgentExitInfo {
  exitCode: number;
  signal?: number;
}

export interface AgentSession {
  id: string;
  agentId: AgentId;
  pid: number;
  startedAt: number;
  cols: number;
  rows: number;
  /** The account active for this session, if any. */
  account?: string;

  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (chunk: string) => void): { dispose(): void };
  onExit(cb: (info: AgentExitInfo) => void): { dispose(): void };
}

export interface AgentRunnerOptions {
  loadPty: () => typeof nodePty;
  sessionIdPrefix?: string;
}

// ──────────────────────────────────────────────
// Implementation
// ──────────────────────────────────────────────

export class AgentRunner {
  private readonly loadPty: () => typeof nodePty;
  private readonly idPrefix: string;

  constructor(opts: AgentRunnerOptions) {
    this.loadPty = opts.loadPty;
    this.idPrefix = opts.sessionIdPrefix ?? "fc-session";
  }

  /**
   * Spawn the agent and return a controllable session. Async so we can
   * await the per-agent mutex + materialise() before the pty starts.
   */
  async spawn(opts: SpawnOptions): Promise<AgentSession> {
    const isManaged = opts.agent.authStyle === "managed-account";
    if (isManaged && opts.account && opts.accountManager) {
      return this.spawnSerialised(opts, opts.accountManager);
    }
    return this.spawnImmediate(opts);
  }

  /**
   * Plain spawn - no account materialisation. Used for agents whose
   * authStyle isn't `managed-account` (Claude cli-login, Gemini api-key,
   * Ollama none) or when no AccountManager is wired.
   */
  private spawnImmediate(opts: SpawnOptions): AgentSession {
    const pty = this.loadPty();
    const { file, args } = buildLaunch(opts.agent, opts.prompt);
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 30;
    const env = mergeEnv(opts.agent, opts.env);

    let proc: nodePty.IPty;
    try {
      proc = pty.spawn(file, args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: opts.cwd,
        env,
        useConpty: process.platform === "win32",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        "AgentRunner.spawn(" + opts.agent.id + ") failed: " + msg +
          "\n  cwd=" + opts.cwd +
          "\n  file=" + file +
          "\n  args=" + JSON.stringify(args),
      );
    }

    const id =
      this.idPrefix + "-" +
      Date.now().toString(36) + "-" +
      Math.random().toString(36).slice(2, 8);

    if (opts.agent.promptInjection === "stdin") {
      setTimeout(() => {
        try {
          proc.write(opts.prompt);
          proc.write("\r");
        } catch {
          /* process may have exited already */
        }
      }, 200);
    }

    const session: AgentSession = {
      id,
      agentId: opts.agent.id,
      pid: proc.pid,
      startedAt: Date.now(),
      cols,
      rows,
      account: opts.account,
      write: (data) => proc.write(data),
      resize: (newCols, newRows) => {
        try {
          proc.resize(newCols, newRows);
          session.cols = newCols;
          session.rows = newRows;
        } catch { /* dead pty */ }
      },
      kill: (signal) => {
        try { proc.kill(signal); } catch { /* already dead */ }
      },
      onData: (cb) => {
        const sub = proc.onData(cb);
        return { dispose: () => sub.dispose() };
      },
      onExit: (cb) => {
        const sub = proc.onExit((e) =>
          cb({ exitCode: e.exitCode, signal: e.signal ?? undefined }),
        );
        return { dispose: () => sub.dispose() };
      },
    };

    return session;
  }

  /**
   * Spawn under per-agent serialisation. Acquires the mutex, materialises
   * auth, spawns, then holds the mutex until session.onExit fires.
   *
   * Implementation: we resolve the caller's promise as soon as pty.spawn
   * returns, but the runSerialised task itself stays pending until the
   * session exits + auth restore completes. That keeps subsequent same-
   * agent spawns queued behind us.
   */
  private spawnSerialised(
    opts: SpawnOptions,
    accountManager: AccountManager,
  ): Promise<AgentSession> {
    if (!opts.account) {
      return this.spawnImmediate(opts) as never;
    }
    return new Promise<AgentSession>((resolve, reject) => {
      let resolved = false;
      void accountManager
        .runSerialised(opts.agent.id, async () => {
          let handle;
          try {
            handle = await accountManager.materialise(opts.agent, opts.account!);
          } catch (err) {
            if (!resolved) reject(err);
            return;
          }
          let session: AgentSession;
          try {
            session = this.spawnImmediate(opts);
          } catch (err) {
            try { await handle.restore(); } catch { /* log via parent */ }
            if (!resolved) reject(err);
            return;
          }
          resolved = true;
          resolve(session);
          // Hold the mutex until exit; restore inside the same critical section.
          await new Promise<void>((finishMutex) => {
            const sub = session.onExit(async () => {
              sub.dispose();
              try { await handle.restore(); } catch { /* swallowed */ }
              finishMutex();
            });
          });
        })
        .catch((err) => {
          if (!resolved) reject(err);
        });
    });
  }
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

export interface LaunchPlan {
  file: string;
  args: string[];
}

export function buildLaunch(agent: AgentDefinition, prompt: string): LaunchPlan {
  const file = agent.launchCmd;
  switch (agent.promptInjection) {
    case "argv":         return { file, args: [prompt] };
    case "flag-prompt":  return { file, args: ["--prompt", prompt] };
    case "stdin":        return { file, args: [] };
    case "http":
      throw new Error(
        "buildLaunch: agent " + agent.id +
          " uses http injection and shouldn't be spawned as a PTY. " +
          "Call its HTTP endpoint instead.",
      );
  }
}

export function mergeEnv(
  agent: AgentDefinition,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") base[k] = v;
  }
  if (process.platform === "win32") {
    if (!base.USERPROFILE && process.env.USERPROFILE) {
      base.USERPROFILE = process.env.USERPROFILE;
    }
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) base[k] = v;
  }
  void agent.envOverrides;
  return base;
}
