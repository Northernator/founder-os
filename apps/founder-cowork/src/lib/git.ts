/**
 * Git helpers for the GitHub Mission Control tab.
 *
 * simple-git is already a dep (used by WorktreeManager). For PR creation we
 * shell out to the `gh` CLI - using the GitHub REST API would require an
 * OAuth token in SecretStorage which is Phase 3 territory.
 */

import * as cp from "node:child_process";
import * as path from "node:path";
import type {
  GitCommitResponse,
  GitCreatePrResponse,
  GitStatusResponse,
} from "@founder-os/mission-control-protocol";
import simpleGit, { type SimpleGit } from "simple-git";

function git(cwd: string): SimpleGit {
  return simpleGit(cwd);
}

export async function status(repoRoot: string): Promise<GitStatusResponse> {
  const g = git(repoRoot);
  const s = await g.status();
  const tracking = s.tracking ?? null;
  // simple-git's StatusResult lists files in a few buckets - flatten them
  // into a single changedFiles list with a one-letter status code.
  const changed: { path: string; status: string }[] = [];
  for (const f of s.modified) changed.push({ path: f, status: "M" });
  for (const f of s.created) changed.push({ path: f, status: "A" });
  for (const f of s.deleted) changed.push({ path: f, status: "D" });
  for (const f of s.renamed) changed.push({ path: typeof f === "string" ? f : f.to, status: "R" });
  for (const f of s.not_added) changed.push({ path: f, status: "?" });
  for (const f of s.conflicted) changed.push({ path: f, status: "U" });

  return {
    branch: s.current ?? null,
    ahead: s.ahead,
    behind: s.behind,
    tracking,
    changedFiles: changed,
    isClean: s.isClean(),
    hasUncommitted: !s.isClean(),
  };
}

export async function createBranch(repoRoot: string, name: string): Promise<{ branch: string }> {
  const safe = sanitize(name);
  if (!safe) throw new Error("branch name is empty after sanitisation");
  const g = git(repoRoot);
  await g.checkoutLocalBranch(safe);
  return { branch: safe };
}

export async function commitAndPush(
  repoRoot: string,
  message: string,
  remote = "origin"
): Promise<GitCommitResponse> {
  const trimmed = message.trim();
  if (!trimmed) throw new Error("commit message cannot be empty");

  const g = git(repoRoot);
  await g.add(["-A"]);
  const commit = await g.commit(trimmed);
  const commitSha = commit.commit;

  // Push - succeed silently if there's no upstream yet by setting it.
  let pushed = false;
  let pushHint: string | undefined;
  try {
    const branch = (await g.branch()).current;
    await g.push(remote, branch, ["--set-upstream"]);
    pushed = true;
  } catch (err) {
    pushHint = err instanceof Error ? err.message : String(err);
  }

  return { commitSha, pushed, pushHint };
}

/**
 * Create a PR via the `gh` CLI. We spawn it directly (no PTY needed) so we
 * can capture stdout for the resulting URL.
 */
export async function createPR(
  repoRoot: string,
  title: string,
  body: string
): Promise<GitCreatePrResponse> {
  const args = ["pr", "create", "--title", title, "--body", body];
  return new Promise((resolve, reject) => {
    const child = cp.spawn("gh", args, {
      cwd: repoRoot,
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (b) => {
      out += b.toString();
    });
    child.stderr?.on("data", (b) => {
      err += b.toString();
    });
    child.on("error", (e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            "Founder Cowork: `gh` CLI not found on PATH. " +
              "Install GitHub CLI (https://cli.github.com) and run `gh auth login`."
          )
        );
      } else {
        reject(e);
      }
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`gh pr create exited ${code}: ${err || out}`));
        return;
      }
      // gh prints the PR URL on the last line of stdout.
      const url = out
        .trim()
        .split(/\r?\n/)
        .reverse()
        .find((l) => l.startsWith("http"));
      if (!url) {
        reject(new Error(`gh pr create returned no URL: ${out}`));
        return;
      }
      resolve({ url });
    });
  });
}

function sanitize(name: string): string {
  return name
    .trim()
    .replace(/[^A-Za-z0-9_./-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export function defaultRepoRoot(): string | null {
  // Resolved by the host using vscode.workspace.workspaceFolders.
  // This helper is here so tests can stub it.
  return null;
}

// re-export path for unit-test convenience
export { path };
