/**
 * WorktreeManager — thin wrapper around `git worktree` for session isolation.
 * Uses simple-git for cross-platform handling. Falls back to repoRoot on
 * failure so sessions always get a working cwd.
 */

import type { SimpleGit } from "simple-git";

export interface WorktreeManagerOptions {
  repoRoot: string;
  git?: SimpleGit;
}

export interface WorktreeRef {
  path: string;
  branch: string;
  headSha: string;
  isFallback?: boolean;
}

export interface CreateWorktreeOptions {
  branch: string;
  baseBranch?: string;
}

export class WorktreeManager {
  private readonly repoRoot: string;
  private git: SimpleGit | null;

  constructor(opts: WorktreeManagerOptions) {
    this.repoRoot = opts.repoRoot;
    this.git = opts.git ?? null;
  }

  async create(opts: CreateWorktreeOptions): Promise<WorktreeRef> {
    const safe = sanitizeBranchForPath(opts.branch);
    const path = this.repoRoot + "--wt-" + safe;

    try {
      const git = await this.ensureGit();
      const args = ["worktree", "add", path, "-b", opts.branch];
      if (opts.baseBranch) args.push(opts.baseBranch);
      await git.raw(args);
      const headSha = (await git.revparse(["HEAD"])).trim();
      return { path, branch: opts.branch, headSha };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already exists") || msg.includes("already checked out")) {
        try {
          const git = await this.ensureGit();
          await git.raw(["worktree", "add", path, opts.branch]);
          const headSha = (await git.revparse(["HEAD"])).trim();
          return { path, branch: opts.branch, headSha };
        } catch {
          // fall through to repoRoot fallback
        }
      }
      // Fallback: just use the repo root so the session can still run.
      let headSha = "";
      try {
        const git = await this.ensureGit();
        headSha = (await git.revparse(["HEAD"])).trim();
      } catch {
        /* no-op */
      }
      return {
        path: this.repoRoot,
        branch: opts.branch,
        headSha,
        isFallback: true,
      };
    }
  }

  async remove(worktreePath: string): Promise<void> {
    if (worktreePath === this.repoRoot) return; // never remove the primary
    const git = await this.ensureGit();
    try {
      await git.raw(["worktree", "remove", "--force", worktreePath]);
    } catch {
      // ignore — user may have removed it manually
    }
  }

  async list(): Promise<WorktreeRef[]> {
    try {
      const git = await this.ensureGit();
      const output = await git.raw(["worktree", "list", "--porcelain"]);
      return parseWorktreePorcelain(output);
    } catch {
      return [];
    }
  }

  private async ensureGit(): Promise<SimpleGit> {
    if (this.git) return this.git;
    const mod = await import("simple-git");
    this.git = mod.simpleGit(this.repoRoot);
    return this.git;
  }
}

export function sanitizeBranchForPath(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
}

export function parseWorktreePorcelain(text: string): WorktreeRef[] {
  const blocks = text.split(/\n\n+/).filter((b) => b.trim());
  const entries: WorktreeRef[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    let path = "";
    let headSha = "";
    let branch = "(detached)";
    for (const line of lines) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("HEAD ")) headSha = line.slice(5);
      else if (line.startsWith("branch ")) branch = line.slice(7).replace(/^refs\/heads\//, "");
    }
    if (path) entries.push({ path, branch, headSha });
  }
  return entries;
}
