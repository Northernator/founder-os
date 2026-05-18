/**
 * HtmlOnlyPdfEngine -- writes the branded HTML next to the .pdf slot
 * and emits a minimal "see HTML" stub PDF.
 *
 * NODE-ONLY. Lives behind /node.
 *
 * Useful when:
 *   - CI smoke tests diff HTML rather than PDF bytes (which would be
 *     brittle under TextEncoder / font version drift).
 *   - The user is iterating on the CSS / brand application and wants
 *     to open the rendered HTML in a browser before committing the
 *     full Tauri-webview print step.
 *
 * Disk layout for each rendered doc:
 *   13_handoff_pack/<category>/<slot>-<id>.pdf       <- 1-page stub
 *   13_handoff_pack/<category>/<slot>-<id>.pdf.html  <- branded HTML
 *
 * The PDF stub is intentionally tiny -- enough to satisfy
 * file-existence checks downstream (INDEX.md / role-pack assembly /
 * desktop "Open PDF" link). The real fidelity lives in the .pdf.html
 * sibling.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  HandoffPackRenderError,
  type PdfEngine,
  type PdfEngineRenderInput,
  type PdfRenderResult,
} from "../types.js";

export type CreateHtmlOnlyPdfEngineOpts = {
  now?: () => Date;
};

export function createHtmlOnlyPdfEngine(
  opts: CreateHtmlOnlyPdfEngineOpts = {}
): PdfEngine {
  const now = opts.now ?? (() => new Date());
  return {
    id: "html-only",
    label: "HTML-only (debug / CI smoke)",
    async render(input: PdfEngineRenderInput): Promise<PdfRenderResult> {
      try {
        await mkdir(dirname(input.outputPath), { recursive: true });
        const htmlPath = `${input.outputPath}.html`;
        await writeFile(htmlPath, input.html, "utf-8");
        const stub = buildStubPdf(input.descriptor.title, input.tokens.companyName);
        await writeFile(input.outputPath, stub);
        return {
          pdfPath: input.outputPath,
          written: true,
          bytesWritten: stub.byteLength,
          status: input.status as PdfRenderResult["status"],
          renderedAt: now().toISOString(),
        };
      } catch (cause) {
        throw new HandoffPackRenderError(
          "html-only",
          input.descriptor.id,
          input.outputPath,
          cause
        );
      }
    },
  };
}

/**
 * A 1-page PDF that says "see <doc>.pdf.html". Reuses the same
 * skeleton as MinimalPdfEngine.buildMinimalPdf but with a fixed body.
 * Duplicating the construction (rather than sharing) keeps this
 * engine standalone -- if MinimalPdfEngine changes for fidelity
 * reasons the stub remains predictable for CI smoke.
 */
function buildStubPdf(title: string, companyName: string): Uint8Array {
  const body = [
    `${title} -- ${companyName}`,
    "",
    "This is a stub PDF. Open the .pdf.html sibling for the",
    "rendered branded HTML.",
  ];
  const stream = [
    "BT",
    "/F2 16 Tf",
    "72 780 Td",
    `(${escapePdfString(body[0]!)}) Tj`,
    "/F1 11 Tf",
    "0 -24 Td",
    `(${escapePdfString(body[2]!)}) Tj`,
    "0 -14 Td",
    `(${escapePdfString(body[3]!)}) Tj`,
    "ET",
  ].join("\n");
  const objects: string[] = [];
  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  objects.push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  objects.push(
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
      "/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> " +
      "/Contents 4 0 R >>\nendobj\n"
  );
  const streamBytes = new TextEncoder().encode(stream);
  objects.push(
    `4 0 obj\n<< /Length ${streamBytes.byteLength} >>\nstream\n${stream}\nendstream\nendobj\n`
  );
  objects.push(
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"
  );
  objects.push(
    "6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n"
  );
  const header = "%PDF-1.4\n%âãÏÓ\n";
  let body2 = "";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(header.length + body2.length);
    body2 += obj;
  }
  const xrefOffset = header.length + body2.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  const full = header + body2 + xref + trailer;
  const out = new Uint8Array(full.length);
  for (let i = 0; i < full.length; i++) {
    out[i] = full.charCodeAt(i) & 0xff;
  }
  return out;
}

function escapePdfString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
