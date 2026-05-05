/**
 * PDFReportGenerator -- renders a SalesMemory into a multi-page PDF
 * report using pdfkit. Node-only (pdfkit depends on node:fs and the
 * legacy node:stream surface).
 *
 * Visual design:
 *  - Brand accent bar (8px) along the top edge of every page
 *  - Cover: large title, prospect URL, generated date, fit-score badge
 *  - Each section: section number + heading on a colored band
 *  - BANT page: filled bar chart replacing the original ASCII bars
 *  - Decision makers: bordered cards stacked vertically
 *  - Outreach emails: bordered cards with colored subject headers
 *  - Footer on every page: prospect name + page X of Y (buffered pages)
 *
 * Pitfalls avoided:
 *  - .fillAndStroke() instead of .fill() after .stroke() (path consumption bug)
 *  - explicit .y reset after geometric primitives so subsequent text does not overlap
 *  - explicit .fillColor("black") reset after colored fills
 *
 * pdfkit is imported lazily so this file can be transpiled without the
 * dependency installed (the package declares it as an optional peer dep).
 */

import { createWriteStream } from "node:fs";

import type { SalesMemory } from "../types.js";

export interface GeneratePdfOpts {
  prospectUrl: string;
  memory: SalesMemory;
  outputPath: string;
}

const COLORS = {
  accent: "#2563eb",
  accentLight: "#dbeafe",
  text: "#0f172a",
  muted: "#64748b",
  border: "#e2e8f0",
  surface: "#f8fafc",
  scoreHigh: "#10b981",
  scoreMid: "#f59e0b",
  scoreLow: "#ef4444",
};

const PAGE = { width: 612, height: 792, margin: 50, contentWidth: 512 };
const TOP_BAR_HEIGHT = 8;
const FOOTER_HEIGHT = 40;

export async function generateSalesReport(opts: GeneratePdfOpts): Promise<string> {
  let PDFDocument: new (opts?: Record<string, unknown>) => PdfDocLike;
  try {
    PDFDocument = (
      (await import("pdfkit")) as unknown as {
        default: new (opts?: Record<string, unknown>) => PdfDocLike;
      }
    ).default;
  } catch (_err) {
    throw new Error(
      "pdfkit is not installed.\n" + "  Run: pnpm --filter @founder-os/sales-agents add pdfkit"
    );
  }
  const doc = new PDFDocument({ margin: PAGE.margin, bufferPages: true });
  const stream = createWriteStream(opts.outputPath);
  doc.pipe(stream);

  // First page is auto-created. Decorate then render cover.
  decorateTopBar(doc);
  renderCover(doc, opts);

  doc.addPage();
  decorateTopBar(doc);
  renderOverview(doc, opts.memory);
  doc.addPage();
  decorateTopBar(doc);
  renderBant(doc, opts.memory);
  doc.addPage();
  decorateTopBar(doc);
  renderDecisionMakers(doc, opts.memory);
  doc.addPage();
  decorateTopBar(doc);
  renderCompetitive(doc, opts.memory);
  doc.addPage();
  decorateTopBar(doc);
  renderOutreach(doc, opts.memory);

  // Footer pass after all content -- needs total page count.
  addFooters(doc, opts);

  doc.end();
  await new Promise<void>((resolve, reject) => {
    stream.on("finish", () => resolve());
    stream.on("error", (e: unknown) => reject(e));
  });
  return opts.outputPath;
}

// ---- Decorations ----

function decorateTopBar(doc: PdfDocLike): void {
  doc.save();
  doc.rect(0, 0, PAGE.width, TOP_BAR_HEIGHT).fill(COLORS.accent);
  doc.restore();
  doc.fillColor(COLORS.text);
  doc.x = PAGE.margin;
  doc.y = PAGE.margin;
}

function addFooters(doc: PdfDocLike, opts: GeneratePdfOpts): void {
  const range = doc.bufferedPageRange();
  const total = range.count;
  const company = opts.memory.research?.company?.name ?? "Sales Report";
  for (let i = 0; i < total; i++) {
    doc.switchToPage(range.start + i);
    // Footer Y sits BELOW the bottom margin -- without disabling
    // the bottom margin pdfkit auto-paginates and we explode from
    // 6 pages to 18. Restore it after each page.
    const origBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = PAGE.height - FOOTER_HEIGHT + 10;
    doc.fillColor(COLORS.muted).fontSize(9).font("Helvetica");
    doc.text(String(company), PAGE.margin, y, { width: PAGE.contentWidth, align: "left" });
    doc.text(`Page ${i + 1} of ${total}`, PAGE.margin, y, {
      width: PAGE.contentWidth,
      align: "right",
    });
    doc.page.margins.bottom = origBottom;
    doc.fillColor(COLORS.text);
  }
}

// ---- Section renderers ----

function renderCover(doc: PdfDocLike, opts: GeneratePdfOpts): void {
  const company = opts.memory.research?.company?.name ?? "Unknown Prospect";
  doc.y = 140;
  doc.fillColor(COLORS.muted).fontSize(11).font("Helvetica").text("SALES INTELLIGENCE REPORT");
  doc.moveDown(0.3);
  doc.fillColor(COLORS.text).fontSize(36).font("Helvetica-Bold").text(company);
  doc.moveDown(0.4);
  doc.fillColor(COLORS.muted).fontSize(12).font("Helvetica").text(opts.prospectUrl);
  doc.moveDown(0.2);
  doc.text(`Generated ${new Date().toLocaleDateString()}`);

  // Fit-score badge
  const fit = opts.memory.bant?.fitScore ?? 0;
  const badgeColor = fit >= 70 ? COLORS.scoreHigh : fit >= 40 ? COLORS.scoreMid : COLORS.scoreLow;
  const badgeY = doc.y + 30;
  const badgeW = 220;
  const badgeH = 90;
  doc.save();
  doc.roundedRect(PAGE.margin, badgeY, badgeW, badgeH, 6).fill(COLORS.surface);
  doc.roundedRect(PAGE.margin, badgeY, 5, badgeH, 2).fill(badgeColor);
  doc.restore();
  doc.fillColor(COLORS.muted).fontSize(10).font("Helvetica");
  doc.text("OVERALL FIT SCORE", PAGE.margin + 18, badgeY + 14);
  doc.fillColor(badgeColor).fontSize(40).font("Helvetica-Bold");
  doc.text(`${fit}`, PAGE.margin + 18, badgeY + 30, { continued: true });
  doc.fillColor(COLORS.muted).fontSize(14).font("Helvetica").text(" / 100");
  doc.fillColor(COLORS.text);
  doc.y = badgeY + badgeH + 20;
}

function renderOverview(doc: PdfDocLike, memory: SalesMemory): void {
  sectionHeading(doc, "01", "Company Overview");
  const c = memory.research?.company ?? {};
  field(doc, "Name", c.name);
  field(doc, "Industry", c.industry);
  field(doc, "Size", c.employees);
  field(doc, "Founded", c.founded);
  field(doc, "Location", c.location);
  field(doc, "Products", c.products);
  if (c.differentiators) {
    doc.moveDown(0.5);
    label(doc, "Differentiators");
    body(doc, String(c.differentiators));
  }
  if (c.recentNews) {
    doc.moveDown(0.5);
    label(doc, "Recent News");
    body(doc, String(c.recentNews));
  }
}

function renderBant(doc: PdfDocLike, memory: SalesMemory): void {
  sectionHeading(doc, "02", "BANT Qualification");
  const bant = memory.bant;
  if (!bant) {
    body(doc, "BANT scoring did not complete.");
    return;
  }
  doc.moveDown(0.3);
  for (const dim of ["budget", "authority", "need", "timeline"] as const) {
    const score = bant.scores[dim] ?? 0;
    drawBantBar(doc, dim, score);
  }
  doc.moveDown(1);
  label(doc, "Reasoning");
  body(doc, bant.reasoning || "(no reasoning provided)");
}

function renderDecisionMakers(doc: PdfDocLike, memory: SalesMemory): void {
  sectionHeading(doc, "03", "Key Decision Makers");
  const contacts = memory.decisionMakers?.contacts ?? [];
  if (contacts.length === 0) {
    body(doc, "No contacts identified.");
    return;
  }
  for (const m of contacts) {
    drawCard(doc, () => {
      doc
        .fillColor(COLORS.text)
        .fontSize(13)
        .font("Helvetica-Bold")
        .text(m.title || "Unknown Role");
      doc.moveDown(0.2);
      doc.fillColor(COLORS.muted).fontSize(10).font("Helvetica");
      const meta = [m.department, m.location].filter(Boolean).join("  |  ");
      if (meta) doc.text(meta);
      if (m.findingTips) {
        doc.moveDown(0.2);
        doc.fillColor(COLORS.text).fontSize(10).font("Helvetica");
        doc.text(`Where to find: ${m.findingTips}`, { width: PAGE.contentWidth - 32 });
      }
    });
  }
}

function renderCompetitive(doc: PdfDocLike, memory: SalesMemory): void {
  sectionHeading(doc, "04", "Competitive Intelligence");
  const intel = memory.competitiveIntel;
  if (!intel) {
    body(doc, "Competitive scan did not complete.");
    return;
  }
  label(doc, "Competitors");
  for (const c of intel.competitors ?? []) {
    drawCard(doc, () => {
      doc.fillColor(COLORS.accent).fontSize(12).font("Helvetica-Bold").text(c.name);
      doc.moveDown(0.2);
      doc.fillColor(COLORS.text).fontSize(10).font("Helvetica");
      doc.text(c.advantage, { width: PAGE.contentWidth - 32 });
    });
  }
  if (intel.painPoints?.length) {
    doc.moveDown(0.5);
    label(doc, "Likely Pain Points");
    for (const p of intel.painPoints) bullet(doc, p);
  }
  if (intel.opportunity) {
    doc.moveDown(0.5);
    label(doc, "Opportunity");
    body(doc, intel.opportunity);
  }
}

function renderOutreach(doc: PdfDocLike, memory: SalesMemory): void {
  sectionHeading(doc, "05", "Outreach Sequence");
  const emails = memory.outreach?.emails ?? [];
  if (emails.length === 0) {
    body(doc, "No outreach generated.");
    return;
  }
  emails.forEach((e, i) => {
    drawCard(doc, () => {
      doc.fillColor(COLORS.accent).fontSize(9).font("Helvetica-Bold");
      doc.text(`EMAIL ${i + 1}`);
      doc.moveDown(0.2);
      doc.fillColor(COLORS.text).fontSize(12).font("Helvetica-Bold").text(e.subject);
      doc.moveDown(0.3);
      doc
        .fontSize(10)
        .font("Helvetica")
        .text(e.body, { width: PAGE.contentWidth - 32 });
    });
  });
}

// ---- Reusable primitives ----

function sectionHeading(doc: PdfDocLike, num: string, title: string): void {
  const y = doc.y + 10;
  doc.save();
  doc.rect(PAGE.margin, y, 4, 28).fill(COLORS.accent);
  doc.restore();
  doc.fillColor(COLORS.muted).fontSize(11).font("Helvetica-Bold");
  doc.text(num, PAGE.margin + 14, y + 2);
  doc.fillColor(COLORS.text).fontSize(20).font("Helvetica-Bold");
  doc.text(title, PAGE.margin + 40, y, { width: PAGE.contentWidth - 40 });
  doc.x = PAGE.margin;
  doc.y = y + 42;
  doc.fillColor(COLORS.text);
}

function field(doc: PdfDocLike, k: string, v: unknown): void {
  doc.fillColor(COLORS.muted).fontSize(9).font("Helvetica-Bold");
  doc.text(k.toUpperCase(), { continued: true });
  doc.fillColor(COLORS.text).fontSize(11).font("Helvetica");
  doc.text(`  ${v ?? "n/a"}`);
}

function label(doc: PdfDocLike, t: string): void {
  doc.fillColor(COLORS.muted).fontSize(9).font("Helvetica-Bold").text(t.toUpperCase());
  doc.moveDown(0.2);
  doc.fillColor(COLORS.text);
}

function body(doc: PdfDocLike, t: string): void {
  doc.fontSize(11).font("Helvetica").fillColor(COLORS.text);
  doc.text(t, { width: PAGE.contentWidth });
}

function bullet(doc: PdfDocLike, t: string): void {
  doc.fontSize(10).font("Helvetica").fillColor(COLORS.text);
  doc.text(`- ${t}`, { width: PAGE.contentWidth });
}

function drawBantBar(doc: PdfDocLike, dim: string, score: number): void {
  const labelText = dim.charAt(0).toUpperCase() + dim.slice(1);
  const y = doc.y + 4;
  const barX = PAGE.margin + 90;
  const barW = 320;
  const barH = 16;
  const filledW = (score / 5) * barW;
  const color = score >= 4 ? COLORS.scoreHigh : score >= 2 ? COLORS.scoreMid : COLORS.scoreLow;

  doc
    .fillColor(COLORS.text)
    .fontSize(11)
    .font("Helvetica-Bold")
    .text(labelText, PAGE.margin, y + 2);
  doc.save();
  doc.rect(barX, y, barW, barH).fill(COLORS.border);
  doc.rect(barX, y, filledW, barH).fill(color);
  doc.restore();
  doc.fillColor(COLORS.muted).fontSize(10).font("Helvetica");
  doc.text(`${score} / 5`, barX + barW + 8, y + 3);
  doc.x = PAGE.margin;
  doc.y = y + barH + 8;
  doc.fillColor(COLORS.text);
}

/**
 * Draw a bordered card with a content callback. Card width = full content
 * width. Card height computed from how far .y advances during the callback.
 * Adds a 12px inner padding and 12px margin between cards.
 */
function drawCard(doc: PdfDocLike, render: () => void): void {
  const startY = doc.y;
  const innerX = PAGE.margin + 16;
  doc.x = innerX;
  doc.y = startY + 12;
  render();
  const endY = doc.y + 8;
  doc.save();
  doc.lineWidth(0.7).strokeColor(COLORS.border);
  doc.roundedRect(PAGE.margin, startY, PAGE.contentWidth, endY - startY, 4).stroke();
  doc.restore();
  doc.x = PAGE.margin;
  doc.y = endY + 12;
  doc.fillColor(COLORS.text);
}

// Minimal structural type so we do not depend on @types/pdfkit at build time.
interface PdfDocLike {
  page: { margins: { bottom: number; top: number; left: number; right: number } };
  pipe(stream: NodeJS.WritableStream): unknown;
  fontSize(size: number): PdfDocLike;
  font(name: string): PdfDocLike;
  text(
    content: string,
    x?: number | Record<string, unknown>,
    y?: number,
    opts?: Record<string, unknown>
  ): PdfDocLike;
  moveDown(lines?: number): PdfDocLike;
  addPage(): PdfDocLike;
  switchToPage(n: number): PdfDocLike;
  bufferedPageRange(): { start: number; count: number };
  moveTo(x: number, y: number): PdfDocLike;
  lineTo(x: number, y: number): PdfDocLike;
  stroke(): PdfDocLike;
  fill(color?: string): PdfDocLike;
  fillAndStroke(fill?: string, stroke?: string): PdfDocLike;
  fillColor(color: string): PdfDocLike;
  strokeColor(color: string): PdfDocLike;
  lineWidth(w: number): PdfDocLike;
  rect(x: number, y: number, w: number, h: number): PdfDocLike;
  roundedRect(x: number, y: number, w: number, h: number, r: number): PdfDocLike;
  save(): PdfDocLike;
  restore(): PdfDocLike;
  end(): void;
  y: number;
  x: number;
}
