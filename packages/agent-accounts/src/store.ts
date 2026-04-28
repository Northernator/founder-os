/**
 * FsAccountStore — file-system backed storage for accounts.
 *
 * Layout under <storageRoot>:
 *   accounts/
 *     <agentId>/
 *       <accountId>/
 *         auth.json     (the raw credentials blob; opaque to us)
 *         meta.json     (Account record minus secrets)
 *
 * <storageRoot> is supplied by the caller; in the VS Code extension it's
 * `context.globalStorageUri.fsPath`. Tests can pass a temp dir.
 *
 * Phase 4 swaps this for an InsForge-backed adapter behind the same
 * AccountStore interface (see src/index.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentId } from "@founder-os/agent-registry";
import type { Account, AccountWithSecrets } from "./account.js";
import { sanitizeAccountId } from "./account.js";

export interface AccountStore {
  list(agentId: AgentId): Account[];
  get(agentId: AgentId, accountId: string): AccountWithSecrets | undefined;
  save(input: AccountWithSecrets): Account;
  delete(agentId: AgentId, accountId: string): void;
  /** Path on disk where the auth.json lives (used by RuntimeHomeService for atomic copy). */
  authJsonPath(agentId: AgentId, accountId: string): string;
}

export interface FsAccountStoreOptions {
  /** Absolute path that contains the `accounts/` subtree. */
  storageRoot: string;
}

export class FsAccountStore implements AccountStore {
  private readonly accountsRoot: string;

  constructor(opts: FsAccountStoreOptions) {
    this.accountsRoot = path.join(opts.storageRoot, "accounts");
  }

  list(agentId: AgentId): Account[] {
    const dir = this.agentDir(agentId);
    if (!fs.existsSync(dir)) return [];
    const out: Account[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const meta = this.readMeta(agentId, entry.name);
      if (meta) out.push(meta);
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }

  get(agentId: AgentId, accountId: string): AccountWithSecrets | undefined {
    const id = sanitizeAccountId(accountId);
    const meta = this.readMeta(agentId, id);
    if (!meta) return undefined;
    const authPath = this.authJsonPath(agentId, id);
    if (!fs.existsSync(authPath)) return undefined;
    let authJson: string;
    try {
      authJson = fs.readFileSync(authPath, "utf-8");
    } catch {
      return undefined;
    }
    return { ...meta, authJson };
  }

  save(input: AccountWithSecrets): Account {
    const id = sanitizeAccountId(input.id);
    const dir = this.accountDir(input.agentId, id);
    fs.mkdirSync(dir, { recursive: true });
    // Write auth.json + meta.json atomically (write-then-rename) so a crashed
    // write doesn't leave half-credentials.
    writeAtomic(path.join(dir, "auth.json"), input.authJson);
    const meta: Account = {
      id,
      agentId: input.agentId,
      label: input.label,
      notes: input.notes,
      createdAt: input.createdAt,
      source: input.source,
    };
    writeAtomic(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    return meta;
  }

  delete(agentId: AgentId, accountId: string): void {
    const id = sanitizeAccountId(accountId);
    const dir = this.accountDir(agentId, id);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  authJsonPath(agentId: AgentId, accountId: string): string {
    const id = sanitizeAccountId(accountId);
    return path.join(this.accountDir(agentId, id), "auth.json");
  }

  // ──────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────

  private agentDir(agentId: AgentId): string {
    return path.join(this.accountsRoot, agentId);
  }

  private accountDir(agentId: AgentId, accountId: string): string {
    return path.join(this.agentDir(agentId), accountId);
  }

  private readMeta(agentId: AgentId, accountId: string): Account | undefined {
    const id = sanitizeAccountId(accountId);
    const metaPath = path.join(this.accountDir(agentId, id), "meta.json");
    if (!fs.existsSync(metaPath)) return undefined;
    try {
      const raw = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as Account;
      // Trust-but-correct the agentId/id fields against directory location.
      raw.id = id;
      raw.agentId = agentId;
      return raw;
    } catch {
      return undefined;
    }
  }
}

function writeAtomic(target: string, content: string): void {
  const tmp = target + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, target);
}
