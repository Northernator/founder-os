/**
 * task-flow - prompt builders and helpers for the Phase 1b.5 PM workflow
 * (analyze -> plan -> execute -> review -> approve / requestRevision)
 * plus the Ask Gemini one-shots.
 *
 * This module is intentionally pure-ish: it builds prompts and runs git ops.
 * The actual agent spawn happens via the existing AgentRunner-backed
 * bindings.spawnSession() so sessions surface in the Mission Control
 * session table without any new plumbing.
 *
 * Files this flow conventionally writes inside the workspace:
 *   ANALYSIS.md   - analyzeRepo output
 *   TASK.md       - planTask output (executor reads this)
 *   REVIEW.md     - reviewExecution output (revision loop reads this)
 */

import * as cp from "node:child_process";
import * as path from "node:path";

export interface TaskFlowFiles {
  analysis: string; // <ws>/ANALYSIS.md
  task: string; // <ws>/TASK.md
  review: string; // <ws>/REVIEW.md
}

export function flowFiles(workspaceRoot: string): TaskFlowFiles {
  return {
    analysis: path.join(workspaceRoot, "ANALYSIS.md"),
    task: path.join(workspaceRoot, "TASK.md"),
    review: path.join(workspaceRoot, "REVIEW.md"),
  };
}

// ──────────────────────────────────────────────
// Prompt builders
// ──────────────────────────────────────────────

export function buildAnalyzePrompt(): string {
  return (
    "You are the Analyzer. Walk this repo and write `ANALYSIS.md` at the " +
    "repo root summarising:\n" +
    "  - High-level purpose and architecture\n" +
    "  - Tech stack + key dependencies\n" +
    "  - Entry points (where execution starts)\n" +
    "  - Notable subsystems or domains\n" +
    "  - Anything risky or non-obvious for a new contributor\n" +
    "Be concrete, cite file paths. Don't change source code."
  );
}

export function buildPlanPrompt(goal: string): string {
  return `You are the PM. Analyze the repo, then write a detailed \`TASK.md\` at the repo root describing the work required to: ${goal}.\n\nInclude:\n  - File-level guidance: which files to edit/create\n  - Step-by-step plan (numbered)\n  - Dependencies / packages to add (if any)\n  - Acceptance criteria\n\nDo NOT write source code yet - the executor will do that. Only write \`TASK.md\`.`;
}

export function buildExecutePrompt(): string {
  return (
    "You are the Executor. Read `TASK.md` at the repo root and implement " +
    "what it describes. Commit incrementally with clear messages. If the " +
    "plan is ambiguous, make a reasonable choice and document it in commit " +
    "messages. Stop when TASK.md's acceptance criteria are met."
  );
}

export function buildReviewPrompt(diffSnippet: string): string {
  const truncatedDiff =
    diffSnippet.length > 60_000
      ? `${diffSnippet.slice(0, 60_000)}\n[... truncated; see git history for full diff ...]`
      : diffSnippet;
  return `You are the Reviewer. The executor has produced changes against this branch. Below is the cumulative diff. Write \`REVIEW.md\` at the repo root with:\n  - What changed (high-level summary)\n  - Issues, bugs, or risks (be specific - cite file:line)\n  - Style/clarity nits\n  - Verdict: APPROVE / REQUEST_REVISION (with reasons)\n\nIf any test commands exist, suggest which ones to run.\n\nDIFF:\n${truncatedDiff}`;
}

export function buildRevisionPrompt(notes: string): string {
  return `You are the Executor revising the previous work. Read \`REVIEW.md\` at the repo root for the reviewer's notes, plus the additional guidance below from the human reviewer. Address each item. Commit incrementally.\n\nADDITIONAL NOTES:\n${notes}`;
}

export function buildAskGeminiPrompt(question: string): string {
  return question;
}

export function buildAskGeminiDiffPrompt(diffSnippet: string, question: string): string {
  const truncatedDiff =
    diffSnippet.length > 60_000
      ? `${diffSnippet.slice(0, 60_000)}\n[... truncated ...]`
      : diffSnippet;
  return `${question}\n\nContext - cumulative diff:\n${truncatedDiff}`;
}

// ──────────────────────────────────────────────
// Git helpers (sync via spawn since simple-git is async + heavy)
// ──────────────────────────────────────────────

/**
 * Cumulative diff against the upstream tracking branch (or main if no
 * upstream is set). Returns "" on failure - prompt builders fall back to
 * "no diff available" hints.
 */
export function gatherDiff(workspaceRoot: string): string {
  // Try upstream first, then origin/main, then HEAD~ as a fallback.
  const candidates = [
    ["diff", "@{upstream}...HEAD"],
    ["diff", "origin/main...HEAD"],
    ["diff", "HEAD~5...HEAD"],
    ["diff"],
  ];
  for (const args of candidates) {
    try {
      const r = cp.spawnSync("git", args, {
        cwd: workspaceRoot,
        encoding: "utf8",
        windowsHide: true,
      });
      if (r.status === 0 && r.stdout && r.stdout.trim().length > 0) {
        return r.stdout;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return "";
}

/**
 * Stage all changes and create an "approved" commit. Returns the new SHA.
 * Throws if there's nothing to commit or git is unhappy.
 */
export function commitApproved(
  workspaceRoot: string,
  reviewer = "Mission Control"
): { commitSha: string } {
  const message = `Approved via ${reviewer}`;
  const add = cp.spawnSync("git", ["add", "-A"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (add.status !== 0) {
    throw new Error(`git add -A failed: ${add.stderr || add.stdout || "unknown"}`);
  }
  const commit = cp.spawnSync("git", ["commit", "-m", message, "--allow-empty"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (commit.status !== 0) {
    throw new Error(`git commit failed: ${commit.stderr || commit.stdout || "unknown"}`);
  }
  const head = cp.spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  return { commitSha: (head.stdout ?? "").trim() };
}

// ──────────────────────────────────────────────
// Stats (Phase 1b.5 - simple counts off SessionSummary[])
// ──────────────────────────────────────────────

export interface SessionsStats {
  total: number;
  running: number;
  exited: number;
  killed: number;
}

export function summariseSessions(
  sessions: { status: "running" | "exited" | "killed" }[]
): SessionsStats {
  const stats: SessionsStats = {
    total: sessions.length,
    running: 0,
    exited: 0,
    killed: 0,
  };
  for (const s of sessions) {
    if (s.status === "running") stats.running++;
    else if (s.status === "exited") stats.exited++;
    else if (s.status === "killed") stats.killed++;
  }
  return stats;
}
