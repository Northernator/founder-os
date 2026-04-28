/**
 * RuntimeHomeService — generalised port of Orca's CodexRuntimeHomeService.
 *
 * Job: materialise an account's auth.json into the agent's configHome
 * (~/.codex/auth.json for Codex, ~/.claude/...something for Claude Code if
 * we ever support multi-account there) before the agent spawns, then
 * restore the previous state afterwards.
 *
 * Key invariants:
 *   1. The user's pre-existing CLI login (whatever was in configHome the
 *      first time we touched it) is captured as a "system-default" snapshot
 *      and is always restorable. We never destroy it.
 *   2. All operations on a given configHome are serialized through a single
 *      mutex per agent so two sessions can't swap auth mid-launch. Callers
 *      should hold the mutex from materialise() through agent spawn through
 *      restore().
 *   3. Every write is atomic (write-then-rename). A power loss leaves either
 *      the old auth or the new auth, never half a file.
 *
 * What this does NOT do:
 *   - It doesn't read or interpret the auth.json contents. The CLI owns the
 *     format; we just shuffle bytes.
 *   - It doesn't know about pty.spawn. Callers (AccountManager.withAccount)
 *     wrap the spawn in materialise/restore.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDefinition } from "@founder-os/agent-registry";
import { SYSTEM_DEFAULT_ID, makeAccount } from "./account.js";
import type { AccountStore } from "./store.js";

export interface RuntimeHomeServiceOptions {
  store: AccountStore;
}

export interface MaterialiseHandle {
  /** Account id whose auth is now active. */
  accountId: string;
  /** Restore whatever was previously active (system-default if first run). */
  restore: () => Promise<void>;
}

export class RuntimeHomeService {
  private readonly store: AccountStore;

  constructor(opts: RuntimeHomeServiceOptions) {
    this.store = opts.store;
  }

  /**
   * Make `accountId` the active credential set for this agent. Returns a
   * handle whose `restore()` puts the previous state back. Callers must
   * call `restore()` (typically in a try/finally around the agent spawn).
   */
  async materialise(agent: AgentDefinition, accountId: string): Promise<MaterialiseHandle> {
    const target = this.targetAuthPath(agent);
    if (!target) {
      throw new Error(
        agent.id +
          " has no configHome/authFile in its AgentDefinition; " +
          "managed-account materialisation isn't supported for it."
      );
    }

    // Capture system-default snapshot if we don't already have one.
    await this.ensureSystemDefaultCaptured(agent, target);

    // Grab the account's stored auth and write it atomically.
    const account = this.store.get(agent.id, accountId);
    if (!account) {
      throw new Error("agent-accounts: account " + accountId + " not found for " + agent.id);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeAtomic(target, account.authJson);

    return {
      accountId,
      restore: async () => {
        // Restore by re-materialising the system-default. If the user has
        // explicitly deleted the system-default snapshot, blow away the
        // file (mirrors the prior behaviour: no Cowork-managed auth left
        // behind).
        const sysDefault = this.store.get(agent.id, SYSTEM_DEFAULT_ID);
        if (sysDefault) {
          writeAtomic(target, sysDefault.authJson);
          return;
        }
        if (fs.existsSync(target)) {
          fs.rmSync(target, { force: true });
        }
      },
    };
  }

  /**
   * On first contact with a managed-account agent, snapshot whatever the
   * user already has at configHome/authFile (e.g. their pre-existing
   * `codex login` state) into our store under the SYSTEM_DEFAULT_ID. Idempotent.
   */
  async ensureSystemDefaultCaptured(agent: AgentDefinition, target: string): Promise<void> {
    if (this.store.get(agent.id, SYSTEM_DEFAULT_ID)) return;
    if (!fs.existsSync(target)) return; // user has never logged in via CLI
    let authJson: string;
    try {
      authJson = fs.readFileSync(target, "utf-8");
    } catch {
      return;
    }
    this.store.save({
      ...makeAccount({
        id: SYSTEM_DEFAULT_ID,
        agentId: agent.id,
        label: "System default (pre-Cowork)",
        source: "system-default",
      }),
      authJson,
    });
  }

  /**
   * Resolve the absolute path to the agent's authFile under its configHome.
   * Returns null if the agent isn't a managed-account agent.
   */
  targetAuthPath(agent: AgentDefinition): string | null {
    if (!agent.configHome || !agent.authFile) return null;
    return path.join(expandHome(agent.configHome), agent.authFile);
  }
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/**
 * Expand a leading `~` to the user's home directory. Mirrors the equivalent
 * helper in src-tauri/src/lib.rs::expand_tilde so behaviour matches across
 * the desktop and the extension.
 */
export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function writeAtomic(target: string, content: string): void {
  const tmp = target + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, target);
}
