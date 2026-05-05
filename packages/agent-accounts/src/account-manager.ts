/**
 * AccountManager — top-level facade for the agent-accounts subsystem.
 *
 * Responsibilities:
 *   - Owns the AccountStore (file-system or future InsForge backend).
 *   - Owns the RuntimeHomeService.
 *   - Serialises materialise/restore operations PER AGENT so two sessions
 *     spawning concurrently for the same agent don't trample each other's
 *     auth.json mid-launch. Different agents run in parallel.
 *   - Exposes a `withAccount()` RAII wrapper that materialises, runs a
 *     callback while holding the mutex, and restores - the canonical
 *     integration point for AgentRunner in Phase 3.2.
 *
 * What it does NOT do:
 *   - It doesn't speak to vscode.SecretStorage. API-key agents (Gemini)
 *     have their secret materialised into env vars by the AgentRunner; that
 *     wiring lives in apps/founder-cowork once 3.2 lands.
 *   - It doesn't pick the account. Callers pass `accountId` through; the
 *     UI lets the user pick.
 */

import type { AgentDefinition, AgentId } from "@founder-os/agent-registry";
import type { Account, AccountWithSecrets } from "./account.js";
import { type MaterialiseHandle, RuntimeHomeService } from "./runtime-home.js";
import type { AccountStore } from "./store.js";

export interface AccountManagerOptions {
  store: AccountStore;
}

export class AccountManager {
  private readonly store: AccountStore;
  private readonly runtimeHome: RuntimeHomeService;
  /** Per-agent FIFO queue. Ensures materialise/restore on the same agent
   *  serialise; cross-agent operations parallelise. */
  private readonly mutexes = new Map<AgentId, Promise<void>>();

  constructor(opts: AccountManagerOptions) {
    this.store = opts.store;
    this.runtimeHome = new RuntimeHomeService({ store: opts.store });
  }

  // ──────────────────────────────────────────────
  // CRUD passthrough (UI uses these directly)
  // ──────────────────────────────────────────────

  list(agentId: AgentId): Account[] {
    return this.store.list(agentId);
  }

  get(agentId: AgentId, accountId: string): AccountWithSecrets | undefined {
    return this.store.get(agentId, accountId);
  }

  save(input: AccountWithSecrets): Account {
    return this.store.save(input);
  }

  delete(agentId: AgentId, accountId: string): void {
    this.store.delete(agentId, accountId);
  }

  // ──────────────────────────────────────────────
  // Materialisation
  // ──────────────────────────────────────────────

  /**
   * Acquire the per-agent mutex, materialise the chosen account into the
   * agent's configHome, run `body`, then restore. Throws propagate after
   * restore runs - callers see the original error and the auth state is
   * never left mutated.
   *
   * Cross-agent calls run in parallel (each agent has its own mutex), so a
   * Codex spawn doesn't block a Gemini spawn.
   */
  async withAccount<T>(
    agent: AgentDefinition,
    accountId: string,
    body: (handle: MaterialiseHandle) => Promise<T>
  ): Promise<T> {
    return this.runSerialised(agent.id, async () => {
      const handle = await this.runtimeHome.materialise(agent, accountId);
      try {
        return await body(handle);
      } finally {
        try {
          await handle.restore();
        } catch (err) {
          // Restore failures are logged via the runtime-home service path,
          // but we rethrow nothing so the original error (if any) wins.
          // eslint-disable-next-line no-console
          console.warn(
            `AccountManager: restore() failed for ${agent.id} account=${handle.accountId}: ${String(err)}`
          );
        }
      }
    });
  }

  /**
   * Lower-level: materialise and return the handle. Caller MUST eventually
   * call `handle.restore()` and is responsible for the per-agent mutex (use
   * runSerialised). Prefer `withAccount` unless you have a long-running
   * non-Promise spawn that needs explicit handle lifetime.
   */
  async materialise(agent: AgentDefinition, accountId: string): Promise<MaterialiseHandle> {
    return this.runtimeHome.materialise(agent, accountId);
  }

  /**
   * Run `task` with the per-agent mutex held. Public so AgentRunner can
   * wrap a manually-managed handle (e.g. node-pty spawn lifetime) inside
   * the same serialisation guarantee.
   */
  runSerialised<T>(agentId: AgentId, task: () => Promise<T>): Promise<T> {
    const prev = this.mutexes.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutexes.set(
      agentId,
      prev.then(() => next)
    );
    return prev.then(async () => {
      try {
        return await task();
      } finally {
        release();
        // Garbage-collect: if no further work was queued behind us, drop
        // the entry so the map doesn't grow unbounded.
        if (this.mutexes.get(agentId) === next.then(() => {})) {
          this.mutexes.delete(agentId);
        }
      }
    });
  }
}
