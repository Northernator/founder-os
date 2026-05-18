/**
 * Shared types for @founder-os/handoff-pack-providers.
 *
 * CLIENT-SAFE -- this file imports no node:* modules. The barrel
 * (./index.ts) re-exports from here; the /node entry point (./node.ts)
 * adds Node-only implementations on top of these contracts. Mirrors
 * the @founder-os/handoff-providers types.ts split.
 */
import { z } from "zod";
import type {
  BrandTokens,
  DocDescriptor,
  DocRenderStatus,
  PdfTemplateConfig,
} from "@founder-os/handoff-pack-core";

// ---------------------------------------------------------------------------
// PdfEngine -- the seam every renderPdfStep call goes through
// ---------------------------------------------------------------------------

/**
 * Result of a single PDF render. Mirrors the field set the
 * InventoryEntry will eventually persist; the renderPdfStep maps this
 * straight into the inventory.
 */
export const PdfRenderResultSchema = z.object({
  /** Absolute on-disk path of the rendered PDF. */
  pdfPath: z.string().min(1),
  /** Whether disk-write actually happened (false for dry runs). */
  written: z.boolean(),
  /** Bytes written. 0 on dry runs. */
  bytesWritten: z.number().int().nonnegative(),
  /** Render status that should be persisted to INDEX.md / inventory. */
  status: z.enum(["generated", "stub", "partial", "manual"]),
  /** ISO datetime stamped at render time. */
  renderedAt: z.string().datetime(),
});
export type PdfRenderResult = z.infer<typeof PdfRenderResultSchema>;

/**
 * Per-render input handed to a PdfEngine. The orchestrator
 * (renderPdfStep) does the markdown -> handlebars -> HTML conversion
 * in client-safe code, then hands the HTML + on-disk target to the
 * engine.
 */
export type PdfEngineRenderInput = {
  /** Final HTML string -- already brand-CSS-injected. */
  html: string;
  /** Absolute path where the PDF should land. */
  outputPath: string;
  /** Doc descriptor -- engines may surface title in PDF metadata. */
  descriptor: DocDescriptor;
  /** Brand tokens -- engines may surface companyName in metadata. */
  tokens: BrandTokens;
  /** Template config -- page size, margins, header/footer flags. */
  config: PdfTemplateConfig;
  /**
   * The tier-derived render status. The engine doesn't override this;
   * it just passes it through to the result so the orchestrator can
   * stamp INDEX.md correctly without an extra dispatch.
   */
  status: DocRenderStatus;
};

/**
 * The PdfEngine contract. Implementations live in /node. The contract
 * is client-safe so callers in the renderer can hold a reference to
 * the type even though instantiation happens Node-side.
 */
export type PdfEngine = {
  /** Stable identifier surfaced in logs / INDEX.md "engine" column. */
  readonly id: PdfEngineId;
  /** Free-form display name for the desktop tab. */
  readonly label: string;
  /**
   * Render `input.html` to PDF at `input.outputPath`. Implementations
   * may write intermediate HTML alongside (e.g. the html-only engine
   * keeps the source HTML next to the PDF for diffing); the returned
   * `bytesWritten` is the PDF's byte count specifically.
   */
  render(input: PdfEngineRenderInput): Promise<PdfRenderResult>;
};

/**
 * Engine identifiers. Slice 2 ships two:
 *   - "minimal-pdf": a tiny, dependency-free PDF emitter. Produces a
 *     valid one-page PDF with the doc's title + body laid out in
 *     Helvetica. This is the engine pipeline-runner uses by default
 *     so the runner never depends on a webview being attached.
 *   - "html-only": writes ONLY the HTML and a placeholder .pdf wrapper
 *     pointing at it. Useful for headless CI smoke checks where binary
 *     diffing PDFs is brittle.
 *
 * Slice 12 adds "tauri-webview" which prints via the desktop webview
 * for full-fidelity output.
 */
export const PdfEngineIdSchema = z.enum([
  "minimal-pdf",
  "html-only",
  "tauri-webview",
]);
export type PdfEngineId = z.infer<typeof PdfEngineIdSchema>;

// ---------------------------------------------------------------------------
// prepareBrandAssetsStep envelopes
// ---------------------------------------------------------------------------

/**
 * Result of prepareBrandAssetsStep. The runner surfaces this in the
 * stage log and uses `tokens` to feed every subsequent renderPdfStep
 * call.
 */
export type PrepareBrandAssetsResult = {
  /** The .brand/ directory written. Always absolute. */
  brandDir: string;
  /** Parsed BrandTokens that were written to brand-tokens.json. */
  tokens: BrandTokens;
  /** Parsed PdfTemplateConfig that was written. */
  config: PdfTemplateConfig;
  /** Whether the logo was copied from 03_brand/logo/exports/. */
  logoCopied: boolean;
  /** Notes the runner should surface in its checkpoint envelope. */
  notes: string[];
};

// ---------------------------------------------------------------------------
// Error classes -- subclassed so callers can branch on the failure mode
// ---------------------------------------------------------------------------

/**
 * Thrown when prepareBrandAssetsStep is asked to run but BRAND has
 * not produced the artefacts it needs (brand-brief.json missing).
 * Fail-closed by design per spec sec 5 ("No silent fallback to
 * default theme -- that defeats the point of branded docs.").
 */
export class HandoffPackBrandMissingError extends Error {
  override readonly name = "HandoffPackBrandMissingError";
  readonly missingPath: string;
  constructor(missingPath: string, message?: string) {
    super(
      message ??
        `BRAND stage has not shipped yet -- expected file not found: ${missingPath}. ` +
          `Run BRAND before HANDOFF_PACK so the renderer has logo + colours to apply.`
    );
    this.missingPath = missingPath;
  }
}

/**
 * Thrown when a PdfEngine implementation fails. Wraps the underlying
 * cause and tags which engine + which doc was affected so INDEX.md
 * can surface the failure in the right row.
 */
export class HandoffPackRenderError extends Error {
  override readonly name = "HandoffPackRenderError";
  readonly engineId: PdfEngineId;
  readonly docId: string;
  readonly outputPath: string;
  constructor(
    engineId: PdfEngineId,
    docId: string,
    outputPath: string,
    cause: unknown
  ) {
    const causeMsg =
      cause instanceof Error ? cause.message : String(cause);
    super(
      `Render failed (engine=${engineId}, doc=${docId}, out=${outputPath}): ${causeMsg}`
    );
    this.engineId = engineId;
    this.docId = docId;
    this.outputPath = outputPath;
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

/**
 * Thrown when the Handlebars-subset template engine cannot resolve a
 * placeholder. The orchestrator can choose to recover by substituting
 * a "{{TODO: founder fills}}" callout or to re-throw (depending on
 * tier).
 */
export class HandoffPackTemplateError extends Error {
  override readonly name = "HandoffPackTemplateError";
  readonly unresolvedPlaceholders: ReadonlyArray<string>;
  constructor(unresolvedPlaceholders: ReadonlyArray<string>, message?: string) {
    super(
      message ??
        `Template has unresolved placeholders: ${unresolvedPlaceholders.join(", ")}`
    );
    this.unresolvedPlaceholders = unresolvedPlaceholders;
  }
}
