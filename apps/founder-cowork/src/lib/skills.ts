/**
 * Skill loader — scans three locations for SKILL.md files and returns a
 * uniform SkillSummary list.
 *
 * Layout (Orca-compatible / Claude Skill-compatible):
 *   <skill-id>/
 *     SKILL.md         <- frontmatter + body
 *     ...other files referenced from SKILL.md
 *
 * Frontmatter format (intentionally shallow — no YAML dep):
 *   ---
 *   name: My Skill
 *   description: When to use this skill
 *   version: 0.1.0
 *   ---
 *   {markdown body}
 *
 * Sources:
 *   1. WORKSPACE — {workspaceRoot}/.founder-cowork/skills/
 *   2. USER      — {globalStorage}/skills/
 *   3. BUNDLED   — {extensionPath}/skills/
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type SkillSource = "workspace" | "user" | "bundled";

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  version?: string;
  source: SkillSource;
  /** Absolute path to the SKILL.md file. */
  filePath: string;
  /** Modification time of SKILL.md (ms since epoch). */
  modifiedAt: number;
}

export interface SkillBody {
  id: string;
  source: SkillSource;
  /** Frontmatter as parsed key/value pairs. */
  frontmatter: Record<string, string>;
  /** Markdown body (text after the second `---`). */
  body: string;
}

export interface SkillScanInput {
  workspaceRoot: string | null;
  userStoragePath: string;
  extensionPath: string;
}

export function listSkills(input: SkillScanInput): SkillSummary[] {
  const out: SkillSummary[] = [];
  for (const [source, dir] of resolveSourceDirs(input)) {
    if (!dir || !fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const skillDir = path.join(dir, ent.name);
      const skillFile = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      try {
        const summary = readSummary(ent.name, skillFile, source);
        out.push(summary);
      } catch {
        // Bad SKILL.md — skip silently. The detail view will surface the
        // parse error if the user clicks into it.
      }
    }
  }
  // Stable order: workspace first, then user, then bundled; alphabetical within.
  out.sort((a, b) => {
    const sa = sourceRank(a.source) - sourceRank(b.source);
    if (sa !== 0) return sa;
    return a.name.localeCompare(b.name);
  });
  return out;
}

export function readSkill(input: SkillScanInput, id: string, source: SkillSource): SkillBody {
  const dirMap = new Map(resolveSourceDirs(input));
  const dir = dirMap.get(source);
  if (!dir) throw new Error("unknown skill source: " + source);
  const skillFile = path.join(dir, id, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    throw new Error("SKILL.md not found at " + skillFile);
  }
  const text = fs.readFileSync(skillFile, "utf8");
  const { frontmatter, body } = parseFrontmatter(text);
  return { id, source, frontmatter, body };
}

// ──────────────────────────────────────────────
// Helpers (exported for tests)
// ──────────────────────────────────────────────

export function parseFrontmatter(text: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  // Tolerate BOM + Windows newlines.
  const clean = text.replace(/^\uFEFF/, "");
  const match = clean.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: clean };
  }
  const [, fmText, body] = match;
  const fm: Record<string, string> = {};
  for (const line of fmText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fm[key] = value;
  }
  return { frontmatter: fm, body };
}

function readSummary(id: string, filePath: string, source: SkillSource): SkillSummary {
  const text = fs.readFileSync(filePath, "utf8");
  const { frontmatter } = parseFrontmatter(text);
  const stat = fs.statSync(filePath);
  return {
    id,
    name: frontmatter.name ?? id,
    description: frontmatter.description ?? "",
    version: frontmatter.version,
    source,
    filePath,
    modifiedAt: stat.mtimeMs,
  };
}

function resolveSourceDirs(input: SkillScanInput): Array<[SkillSource, string | null]> {
  const ws = input.workspaceRoot
    ? path.join(input.workspaceRoot, ".founder-cowork", "skills")
    : null;
  return [
    ["workspace", ws],
    ["user", path.join(input.userStoragePath, "skills")],
    ["bundled", path.join(input.extensionPath, "skills")],
  ];
}

function sourceRank(s: SkillSource): number {
  switch (s) {
    case "workspace":
      return 0;
    case "user":
      return 1;
    case "bundled":
      return 2;
  }
}
