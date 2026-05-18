/**
 * renderInventoryMarkdown -- pure builder for 13_handoff_pack/INDEX.md.
 *
 * CLIENT-SAFE -- no node:* imports. Lives in the main barrel so the
 * desktop tab (slice 12) can render a preview without booting the
 * Node-only orchestrator.
 *
 * Replaces the slice-4 inline `renderSkeletalIndex` helper that lived
 * in handoff-pack-runner.ts. The skeletal version surfaced static tier
 * totals only; this real version surfaces per-doc rows with status +
 * tier badge + last-rendered timestamp, grouped by category.
 *
 * Output shape (per spec sec 9 + sec 13):
 *   - One H1 with the venture name.
 *   - Generated-at + tier-breakdown summary block.
 *   - One H2 per category, with a markdown table:
 *       | Slot | Tier | Doc | Status | Rendered at | Notes |
 *   - Optional role-pack section (slice 10 lands the role-pack
 *     entries; for slice 5 the inventory's rolePacks map is empty
 *     and the section is omitted).
 *   - Solicitor-review banner for any tier-C/D row whose status is
 *     not "manual" (spec sec 13 risk row 4).
 *
 * The renderer is intentionally permissive: it accepts the inventory
 * as-is and never throws. Callers that need schema validation should
 * parse through HandoffPackInventorySchema first.
 */
import {
  CATEGORY_DIR_NAMES,
  type CategorySlot,
  type DocRenderStatus,
  type HandoffPackInventory,
  type InventoryEntry,
  type Role,
  type Tier,
} from "@founder-os/handoff-pack-core";

export type RenderInventoryMarkdownOpts = {
  inventory: HandoffPackInventory;
  /**
   * Spec rev pin -- surfaced in the footer so a reader can match the
   * pack against the spec version that produced it. Defaults to the
   * 2026-05-17 sign-off revision. Slice 13's ship notes can bump
   * this when the spec is amended.
   */
  specRev?: string;
};

/**
 * Build the INDEX.md body string. Pure -- no IO, no clock, no
 * randomness. The inventory itself is the only source of mutable state.
 */
export function renderInventoryMarkdown(opts: RenderInventoryMarkdownOpts): string {
  const inv = opts.inventory;
  const specRev = opts.specRev ?? "2026-05-17";
  const lines: string[] = [];

  // --- Header ---------------------------------------------------------
  lines.push(`# Handoff pack -- ${inv.ventureName}`);
  lines.push("");
  lines.push(
    `_Generated **${inv.generatedAt}** from the HANDOFF_PACK stage runner. ` +
      `Spec rev \`${specRev}\` -- ${countSummary(inv.entries, inv.totalDocs)}._`
  );
  lines.push("");

  // --- Top-level facts ------------------------------------------------
  lines.push(`- **Venture slug:** \`${inv.ventureSlug}\``);
  lines.push(`- **Total documents in manifest:** ${inv.totalDocs}`);
  const tiers = countByTier(inv.entries);
  lines.push(
    `- **Tier breakdown:** A=${tiers.A} -- B=${tiers.B} -- C=${tiers.C} -- D=${tiers.D}`
  );
  const statuses = countByStatus(inv.entries);
  lines.push(
    `- **Status breakdown:** generated=${statuses.generated} -- partial=${statuses.partial} -- ` +
      `stub=${statuses.stub} -- manual=${statuses.manual} -- failed=${statuses.failed} -- ` +
      `pending=${statuses.pending}`
  );
  lines.push("");

  // --- Per-category tables -------------------------------------------
  const grouped = groupByCategory(inv.entries);
  const orderedCategories: ReadonlyArray<CategorySlot> = [
    "00-company-control",
    "01-strategy",
    "02-product",
    "03-design-brand",
    "04-engineering",
    "05-security-data-compliance",
    "06-people-hr",
    "07-finance-admin",
    "08-sales-marketing",
    "09-customer-success",
    "10-templates",
  ];
  for (const cat of orderedCategories) {
    const rows = grouped.get(cat) ?? [];
    if (rows.length === 0) continue;
    lines.push(`## ${humanCategoryHeading(cat)}`);
    lines.push("");
    lines.push(`Folder: \`${CATEGORY_DIR_NAMES[cat]}/\``);
    lines.push("");
    lines.push("| Slot | Tier | Doc | Status | Rendered at | PDF |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    // Stable ordering within a category: slot ascending.
    const ordered = [...rows].sort((a, b) => a.slot.localeCompare(b.slot));
    for (const row of ordered) {
      lines.push(buildRow(row));
    }
    lines.push("");
  }

  // --- Role packs section (slice 10 populates this) ------------------
  const rolePackEntries = Object.entries(inv.rolePacks ?? {}) as Array<
    [Role, "generated" | "skipped" | "failed"]
  >;
  if (rolePackEntries.length > 0) {
    lines.push("## Role packs");
    lines.push("");
    lines.push("| Role | Status |");
    lines.push("| --- | --- |");
    for (const [role, status] of rolePackEntries) {
      lines.push(`| ${role} | ${status} |`);
    }
    lines.push("");
  }

  // --- Footer -------------------------------------------------------
  lines.push("---");
  lines.push("");
  lines.push(
    "Tier guide: **A** Golden 15 (LLM-generated from pipeline outputs) -- " +
      "**B** Extended generated (lower fidelity) -- " +
      "**C** Partial stub (some placeholders filled, founder completes the rest) -- " +
      "**D** Pure stub (TODO callouts, founder authors)."
  );
  lines.push("");
  lines.push(
    "Status guide: **generated** all placeholders resolved -- " +
      "**partial** some placeholders unresolved (TODO callouts inserted) -- " +
      "**stub** tier-D blank template rendered -- " +
      "**manual** founder edited after render -- " +
      "**failed** renderer error (see `failureReason`) -- " +
      "**pending** descriptor in manifest but not yet rendered."
  );
  lines.push("");
  lines.push(
    `> Tier-C and Tier-D documents include a SOLICITOR REVIEW REQUIRED banner ` +
      `in their bodies (spec sec 13). Do not publish, sign, or share before ` +
      `legal sign-off.`
  );
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRow(row: InventoryEntry): string {
  const tierBadge = tierBadgeFor(row.tier);
  const statusBadge = statusBadgeFor(row.status);
  const rendered = row.lastRenderedAt ?? "--";
  const pdfCell = pdfCellFor(row);
  // Note column omitted in this rev -- failureReason is surfaced via
  // status badge "failed" + a separate Failures section if any.
  return `| ${row.slot} | ${tierBadge} | ${escapeCell(row.title)} | ${statusBadge} | ${rendered} | ${pdfCell} |`;
}

function tierBadgeFor(tier: Tier): string {
  switch (tier) {
    case "A":
      return "A (golden)";
    case "B":
      return "B (extended)";
    case "C":
      return "C (partial)";
    case "D":
      return "D (stub)";
    default:
      return tier;
  }
}

function statusBadgeFor(status: DocRenderStatus): string {
  switch (status) {
    case "generated":
      return "generated";
    case "partial":
      return "partial";
    case "stub":
      return "stub";
    case "manual":
      return "manual";
    case "failed":
      return "FAILED";
    case "pending":
      return "pending";
    default:
      return status;
  }
}

function pdfCellFor(row: InventoryEntry): string {
  if (row.status === "pending" || row.status === "failed") return "--";
  return `\`${row.pdfRelativePath}\``;
}

function escapeCell(s: string): string {
  // Markdown table cells: escape pipes and backslashes; collapse newlines.
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

function humanCategoryHeading(cat: CategorySlot): string {
  // "00-company-control" -> "Company Control".
  return cat
    .replace(/^\d+-/, "")
    .split("-")
    .map((p) => (p.length === 0 ? p : p[0]!.toUpperCase() + p.slice(1)))
    .join(" ");
}

function groupByCategory(
  entries: ReadonlyArray<InventoryEntry>
): Map<CategorySlot, InventoryEntry[]> {
  const out = new Map<CategorySlot, InventoryEntry[]>();
  for (const e of entries) {
    const arr = out.get(e.category) ?? [];
    arr.push(e);
    out.set(e.category, arr);
  }
  return out;
}

function countByTier(
  entries: ReadonlyArray<InventoryEntry>
): Record<Tier, number> {
  const out: Record<Tier, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const e of entries) out[e.tier]++;
  return out;
}

function countByStatus(
  entries: ReadonlyArray<InventoryEntry>
): Record<DocRenderStatus, number> {
  const out: Record<DocRenderStatus, number> = {
    generated: 0,
    partial: 0,
    stub: 0,
    manual: 0,
    failed: 0,
    pending: 0,
  };
  for (const e of entries) out[e.status]++;
  return out;
}

function countSummary(
  entries: ReadonlyArray<InventoryEntry>,
  totalDocs: number
): string {
  const statuses = countByStatus(entries);
  const rendered = statuses.generated + statuses.partial + statuses.stub + statuses.manual;
  return `${rendered}/${totalDocs} PDFs on disk (${statuses.failed} failed, ${statuses.pending} pending)`;
}
