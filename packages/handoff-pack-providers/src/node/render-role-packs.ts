/**
 * Slice 10 -- role-pack assembly.
 *
 * Builds one branded PDF per default role pack. Each PDF is a curated
 * onboarding bundle with cover copy plus an ordered index of the
 * already-rendered per-doc PDFs for that role.
 */
import {
  DEFAULT_ROLE_PACKS,
} from "@founder-os/handoff-pack-core/role-packs";
import {
  rolePackBasenameFor,
  type BrandTokens,
  type DocDescriptor,
  type InventoryEntry,
  type PdfTemplateConfig,
  type Role,
  type RolePackDescriptor,
} from "@founder-os/handoff-pack-core";
import {
  getHandoffPackRolePackPath,
} from "@founder-os/workspace-core";
import { wrapBrandedHtml } from "../css-template.js";
import {
  HandoffPackRenderError,
  type PdfEngine,
  type PdfRenderResult,
} from "../types.js";
import { createMinimalPdfEngine } from "./minimal-pdf-engine.js";

export type RenderRolePacksStepOpts = {
  ventureRoot: string;
  ventureName: string;
  ventureSlug: string;
  tokens: BrandTokens;
  config: PdfTemplateConfig;
  engine?: PdfEngine;
  now?: () => Date;
  inventoryEntries: ReadonlyArray<InventoryEntry>;
  rolePacks?: ReadonlyArray<RolePackDescriptor>;
  includeRoles?: ReadonlyArray<Role>;
};

export type RenderRolePacksStepResult = {
  rolePacks: Record<Role, "generated" | "skipped" | "failed">;
  results: Array<{
    role: Role;
    title: string;
    pdfPath: string;
    status: "generated" | "skipped" | "failed";
    bytesWritten: number;
    docsIncluded: number;
    docsUnavailable: number;
    renderedAt?: string;
    failureReason?: string;
  }>;
  counts: {
    generated: number;
    skipped: number;
    failed: number;
  };
  notes: string[];
};

export async function renderRolePacksStep(
  opts: RenderRolePacksStepOpts
): Promise<RenderRolePacksStepResult> {
  const now = opts.now ?? (() => new Date());
  const engine = opts.engine ?? createMinimalPdfEngine({ now });
  const packs = opts.rolePacks ?? DEFAULT_ROLE_PACKS;
  const includeRoles = opts.includeRoles ? new Set<Role>(opts.includeRoles) : undefined;
  const entriesByDocId = new Map(opts.inventoryEntries.map((entry) => [entry.docId, entry]));

  const rolePacks = {} as Record<Role, "generated" | "skipped" | "failed">;
  const results: RenderRolePacksStepResult["results"] = [];
  const notes: string[] = [];
  const counts: RenderRolePacksStepResult["counts"] = {
    generated: 0,
    skipped: 0,
    failed: 0,
  };

  for (const pack of packs) {
    const outputPath = getHandoffPackRolePackPath(opts.ventureRoot, pack.role);
    if (includeRoles && !includeRoles.has(pack.role)) {
      rolePacks[pack.role] = "skipped";
      counts.skipped++;
      results.push({
        role: pack.role,
        title: pack.title,
        pdfPath: outputPath,
        status: "skipped",
        bytesWritten: 0,
        docsIncluded: 0,
        docsUnavailable: pack.docIds.length,
      });
      notes.push(`role-pack:${pack.role} skipped`);
      continue;
    }

    const rows = pack.docIds.map((docId) => entriesByDocId.get(docId));
    const docsIncluded = rows.filter((entry) => entry && isAvailable(entry)).length;
    const docsUnavailable = pack.docIds.length - docsIncluded;
    const descriptor = rolePackDescriptorToDocDescriptor(pack);
    const bodyHtml = buildRolePackBodyHtml(pack, opts, rows);
    const html = wrapBrandedHtml({
      bodyHtml,
      descriptor,
      tokens: opts.tokens,
      config: opts.config,
    });

    try {
      const rendered = await engine.render({
        html,
        outputPath,
        descriptor,
        tokens: opts.tokens,
        config: opts.config,
        status: "generated",
      });
      rolePacks[pack.role] = "generated";
      counts.generated++;
      results.push(resultRow(pack, rendered, docsIncluded, docsUnavailable));
      notes.push(
        `role-pack:${pack.role} generated docs=${docsIncluded} unavailable=${docsUnavailable}`
      );
    } catch (err) {
      const reason = formatRenderError(err);
      rolePacks[pack.role] = "failed";
      counts.failed++;
      results.push({
        role: pack.role,
        title: pack.title,
        pdfPath: outputPath,
        status: "failed",
        bytesWritten: 0,
        docsIncluded,
        docsUnavailable,
        failureReason: reason,
      });
      notes.push(`role-pack:${pack.role} failed -- ${reason}`);
    }
  }

  return { rolePacks, results, counts, notes };
}

function rolePackDescriptorToDocDescriptor(pack: RolePackDescriptor): DocDescriptor {
  return {
    id: `${pack.role}-role-pack`,
    category: "10-templates",
    slot: "00",
    title: pack.title,
    description: `Curated onboarding pack for ${pack.role}`,
    tier: "A",
    roles: [pack.role],
    sourceStages: [],
    templatePath: "",
    placeholders: [],
  };
}

function resultRow(
  pack: RolePackDescriptor,
  rendered: PdfRenderResult,
  docsIncluded: number,
  docsUnavailable: number
): RenderRolePacksStepResult["results"][number] {
  return {
    role: pack.role,
    title: pack.title,
    pdfPath: rendered.pdfPath,
    status: "generated",
    bytesWritten: rendered.bytesWritten,
    docsIncluded,
    docsUnavailable,
    renderedAt: rendered.renderedAt,
  };
}

function buildRolePackBodyHtml(
  pack: RolePackDescriptor,
  opts: RenderRolePacksStepOpts,
  rows: Array<InventoryEntry | undefined>
): string {
  const generatedAt = (opts.now ?? (() => new Date()))().toISOString();
  const lines: string[] = [];
  lines.push(`<h1>${escapeHtml(pack.title)}</h1>`);
  lines.push(`<p>${escapeHtml(pack.introText)}</p>`);
  lines.push(`<p><strong>Company:</strong> ${escapeHtml(opts.ventureName)}</p>`);
  lines.push(`<p><strong>Generated:</strong> ${escapeHtml(generatedAt)}</p>`);
  lines.push("<h2>Documents</h2>");
  lines.push("<ol>");
  for (let i = 0; i < pack.docIds.length; i++) {
    const docId = pack.docIds[i]!;
    const entry = rows[i];
    if (!entry) {
      lines.push(`<li><strong>${escapeHtml(docId)}</strong> - missing from inventory</li>`);
      continue;
    }
    const status = isAvailable(entry) ? entry.status : `${entry.status} - unavailable`;
    lines.push(
      `<li><strong>${escapeHtml(entry.title)}</strong> ` +
        `<span>(${escapeHtml(entry.tier)}, ${escapeHtml(status)})</span><br>` +
        `<code>${escapeHtml(entry.pdfRelativePath)}</code></li>`
    );
  }
  lines.push("</ol>");
  lines.push("<h2>Use</h2>");
  lines.push(
    "<p>Open the document paths above from the main handoff pack when you need the full source PDF. " +
      "This role pack is the ordered reading guide for the role.</p>"
  );
  return lines.join("\n");
}

function isAvailable(entry: InventoryEntry): boolean {
  return entry.status !== "failed" && entry.status !== "pending";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function formatRenderError(err: unknown): string {
  if (err instanceof HandoffPackRenderError) {
    return `render error (engine=${err.engineId}, out=${err.outputPath}): ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
