/**
 * Account model. An "account" is a per-agent set of credentials the user has
 * registered with Founder Cowork. For managed-account agents (Codex), each
 * account corresponds to an `auth.json` blob captured from the agent's CLI
 * after `codex login`. The user can register multiple accounts and switch
 * between them per session.
 *
 * Account ids are user-supplied slugs (e.g. "personal", "client-acme").
 */

import type { AgentId } from "@founder-os/agent-registry";

export interface Account {
  /** User-supplied slug, unique within (agentId). */
  id: string;
  agentId: AgentId;
  /** Human label shown in pickers. */
  label: string;
  /** Optional notes (e.g. organisation, last-used context). */
  notes?: string;
  /** ISO-8601 timestamp the account was registered with Cowork. */
  createdAt: string;
  /**
   * Where the credentials originally came from. "imported" means the user
   * pasted/dragged an auth.json; "captured" means we snapshotted from a
   * `<agent> login` flow. Just metadata - storage is uniform.
   */
  source: "imported" | "captured" | "system-default";
}

export interface AccountWithSecrets extends Account {
  /**
   * Raw credentials JSON exactly as the agent's CLI writes it. We never
   * inspect or transform it - we only copy it into the agent's configHome
   * at materialization time.
   */
  authJson: string;
}

/**
 * The id reserved for the snapshot of whatever was in the agent's configHome
 * the very first time Cowork ran. We always restore this on session end so
 * the user's pre-existing CLI login isn't lost.
 */
export const SYSTEM_DEFAULT_ID = "system-default";

export function makeAccount(input: {
  id: string;
  agentId: AgentId;
  label?: string;
  notes?: string;
  source: Account["source"];
}): Account {
  return {
    id: sanitizeAccountId(input.id),
    agentId: input.agentId,
    label: input.label ?? input.id,
    notes: input.notes,
    createdAt: new Date().toISOString(),
    source: input.source,
  };
}

/** Permit only filename-safe chars. Empty strings throw. */
export function sanitizeAccountId(raw: string): string {
  const slug = raw.trim().replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 64);
  if (!slug) throw new Error("account id is empty after sanitisation");
  return slug;
}
