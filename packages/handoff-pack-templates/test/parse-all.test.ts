/**
 * parse-all.test.ts -- drift-protection smoke test for the on-disk
 * template tree. Asserts that:
 *   1. Every .md.hbs file under templates/ corresponds to a DOC_MANIFEST
 *      entry (no orphan templates).
 *   2. Every DOC_MANIFEST entry has a file at its declared templatePath
 *      (no orphan manifest rows).
 *   3. Every file has YAML frontmatter with docId/tier/category that
 *      matches the manifest.
 *   4. The body parses cleanly through the slice-2 Handlebars-subset
 *      template engine (lenient mode) AND the markdown-subset engine.
 *   5. Per-tier and per-category counts match what slice 1 promised
 *      (A=16, B=27, C=34, D=129 / 11 categories).
 *
 * If any of these fails the smoke test fails -- which means slice 5's
 * renderAllStubsStep can rely on the invariants above without
 * re-checking at runtime.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DOC_MANIFEST } from "@founder-os/handoff-pack-core/manifest";
import {
  renderTemplate,
  markdownToHtml,
} from "@founder-os/handoff-pack-providers";

const TEMPLATES_ROOT = join(__dirname, "..", "templates");

type FoundTemplate = {
  /** Path relative to templates/, with forward slashes (matches manifest.templatePath). */
  relPath: string;
  /** Raw file contents. */
  raw: string;
};

function walk(dir: string, found: FoundTemplate[] = []): FoundTemplate[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full, found);
    } else if (entry.endsWith(".md.hbs")) {
      const raw = readFileSync(full, "utf8");
      const rel = relative(TEMPLATES_ROOT, full).split(sep).join("/");
      found.push({ relPath: rel, raw });
    }
  }
  return found;
}

type Frontmatter = {
  docId?: string;
  tier?: string;
  category?: string;
  title?: string;
};

/** Lightweight YAML-subset parser. We only need flat string keys. */
function parseFrontmatter(raw: string): { fm: Frontmatter; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { fm: {}, body: raw };
  const fm: Frontmatter = {};
  const body = m[2] ?? "";
  for (const line of (m[1] ?? "").split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1] as keyof Frontmatter;
    const value = kv[2] ?? "";
    fm[key] = value.trim();
  }
  return { fm, body };
}

describe("@founder-os/handoff-pack-templates -- on-disk template tree", () => {
  const found = walk(TEMPLATES_ROOT);
  const byPath = new Map(found.map((f) => [f.relPath, f]));
  const manifestByPath = new Map(
    DOC_MANIFEST.map((d) => [d.templatePath, d] as const),
  );

  it("manifest has 206 entries with the promised per-tier split", () => {
    expect(DOC_MANIFEST.length).toBe(206);
    const counts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
    for (const d of DOC_MANIFEST) counts[d.tier] = (counts[d.tier] ?? 0) + 1;
    expect(counts).toEqual({ A: 16, B: 27, C: 34, D: 129 });
  });

  it("disk has the same 206 templates with no orphans either way", () => {
    expect(found.length).toBe(206);

    const orphanFiles: string[] = [];
    for (const f of found) {
      if (!manifestByPath.has(f.relPath)) orphanFiles.push(f.relPath);
    }
    const orphanManifest: string[] = [];
    for (const d of DOC_MANIFEST) {
      if (!byPath.has(d.templatePath)) orphanManifest.push(d.templatePath);
    }
    expect(orphanFiles, `files with no manifest row: ${orphanFiles.join(", ")}`).toEqual([]);
    expect(orphanManifest, `manifest rows with no file: ${orphanManifest.join(", ")}`).toEqual([]);
  });

  it("every template has frontmatter that matches the manifest row", () => {
    const bad: string[] = [];
    for (const [path, doc] of manifestByPath) {
      const f = byPath.get(path);
      if (!f) continue; // covered by previous test
      const { fm } = parseFrontmatter(f.raw);
      if (fm.docId !== doc.id) bad.push(`${path}: docId ${fm.docId} != ${doc.id}`);
      if (fm.tier !== doc.tier) bad.push(`${path}: tier ${fm.tier} != ${doc.tier}`);
      if (fm.category !== doc.category) bad.push(`${path}: category ${fm.category} != ${doc.category}`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("every template body renders through the Handlebars subset (lenient)", () => {
    const failures: string[] = [];
    for (const f of found) {
      const { body } = parseFrontmatter(f.raw);
      try {
        const result = renderTemplate(body, {}, "lenient");
        // lenient mode should never throw; output is allowed to contain
        // hp-todo callouts for unresolved {{var}}.
        if (typeof result.output !== "string") {
          failures.push(`${f.relPath}: render returned non-string`);
        }
      } catch (e) {
        failures.push(`${f.relPath}: ${(e as Error).message}`);
      }
    }
    expect(failures, failures.slice(0, 20).join("\n")).toEqual([]);
  });

  it("every rendered body parses through the markdown subset", () => {
    const failures: string[] = [];
    for (const f of found) {
      const { body } = parseFrontmatter(f.raw);
      try {
        const rendered = renderTemplate(body, {}, "lenient");
        const html = markdownToHtml(rendered.output);
        if (typeof html !== "string" || html.length === 0) {
          failures.push(`${f.relPath}: empty html`);
        }
      } catch (e) {
        failures.push(`${f.relPath}: ${(e as Error).message}`);
      }
    }
    expect(failures, failures.slice(0, 20).join("\n")).toEqual([]);
  });

  it("solicitor banner is present on every legal/HR/security template", () => {
    const SOLICITOR_CATEGORIES = new Set([
      "00-company-control",
      "05-security-data-compliance",
      "06-people-hr",
    ]);
    const missing: string[] = [];
    for (const f of found) {
      const { fm } = parseFrontmatter(f.raw);
      if (fm.category && SOLICITOR_CATEGORIES.has(fm.category)) {
        if (!f.raw.includes("SOLICITOR REVIEW REQUIRED")) {
          missing.push(f.relPath);
        }
      }
    }
    expect(missing, `missing solicitor banner: ${missing.join(", ")}`).toEqual([]);
  });

  it("per-category file counts match the manifest", () => {
    const onDisk: Record<string, number> = {};
    for (const f of found) {
      const cat = f.relPath.split("/")[0] ?? "_unknown";
      onDisk[cat] = (onDisk[cat] ?? 0) + 1;
    }
    const inManifest: Record<string, number> = {};
    for (const d of DOC_MANIFEST) {
      inManifest[d.category] = (inManifest[d.category] ?? 0) + 1;
    }
    expect(onDisk).toEqual(inManifest);
  });
});
