/**
 * @founder-os/handoff-pack-providers public entry -- CLIENT-SAFE.
 *
 * Slice 2 of the HANDOFF_PACK arc. This barrel imports ZERO node:*
 * modules. Anything that touches the filesystem (prepareBrandAssetsStep,
 * renderPdfStep, the minimal-pdf and html-only PdfEngine
 * implementations) lives in the "./node" subpath:
 *
 *   import {
 *     prepareBrandAssetsStep,
 *     renderPdfStep,
 *     createMinimalPdfEngine,
 *     createHtmlOnlyPdfEngine,
 *   } from "@founder-os/handoff-pack-providers/node";
 *
 * Why split: the Tauri WebView (and any other browser-like consumer)
 * bundles this barrel via Vite. If Node-only code reached this file
 * Vite would externalise the node:* imports and the resulting stubs
 * throw on access, crashing React mount before any UI renders. The
 * split makes the boundary a hard import-path error instead of a
 * silent runtime crash. Mirrors @founder-os/media-providers,
 * @founder-os/crm-providers, @founder-os/handoff-providers,
 * @founder-os/backend-providers, @founder-os/social-providers.
 *
 * What lives in this client-safe barrel:
 *   - The PdfEngine contract (id, render envelope, error classes).
 *   - The Handlebars-subset template engine -- pure text in / text
 *     out, safe to call in the renderer when the desktop tab wants to
 *     preview a rendered template before kicking off the Node-side
 *     write.
 *   - The markdown-subset converter -- same idea.
 *   - The brand CSS builder + branded-HTML wrapper -- the renderer
 *     can preview the wrapped HTML inside an iframe before the user
 *     clicks "render to PDF".
 *   - The slice-2 proof template + descriptor constant so tests in
 *     downstream packages can drive a deterministic fixture.
 *
 * What's in /node only:
 *   - prepareBrandAssetsStep (reads brand-brief.json + copies logo)
 *   - renderPdfStep (markdown -> handlebars -> HTML -> PDF on disk)
 *   - createMinimalPdfEngine (emits a real PDF binary)
 *   - createHtmlOnlyPdfEngine (writes HTML next to the .pdf slot)
 */

// PdfEngine contract + render envelopes + error classes.
export {
  PdfEngineIdSchema,
  PdfRenderResultSchema,
  HandoffPackBrandMissingError,
  HandoffPackRenderError,
  HandoffPackTemplateError,
  type PdfEngine,
  type PdfEngineId,
  type PdfEngineRenderInput,
  type PdfRenderResult,
  type PrepareBrandAssetsResult,
} from "./types.js";

// Handlebars-subset template engine -- pure text transform.
export {
  renderTemplate,
  type TemplateContext,
  type TemplateRenderResult,
} from "./template-engine.js";

// Markdown-subset to HTML converter.
export { markdownToHtml } from "./markdown-engine.js";

// Brand CSS + branded HTML wrapping.
export {
  buildBrandCss,
  wrapBrandedHtml,
  type WrapHtmlOpts,
} from "./css-template.js";

// Slice-2 proof template + descriptor (mirrors the manifest entry).
export {
  SLICE_2_PROOF_TEMPLATE,
  SLICE_2_PROOF_DESCRIPTOR,
} from "./proof-template.js";
// Pure INDEX.md builder (slice 5). Stays in the client-safe barrel so
// the desktop tab (slice 12) can render a preview of the inventory
// without booting the Node-only orchestrator.
export {
  renderInventoryMarkdown,
  type RenderInventoryMarkdownOpts,
} from "./inventory-markdown.js";
