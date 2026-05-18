/**
 * Branded CSS shell + HTML wrapping for handoff-pack PDFs.
 *
 * CLIENT-SAFE -- no node:* imports. Both engines call into this so
 * the brand application is one source of truth. Slice 5 onward may
 * grow per-tier overrides (Tier A gets richer typography, etc.); the
 * signature stays stable.
 *
 * Output is the FULL HTML document the PDF engine swallows, with
 * brand tokens applied at the :root level via CSS custom properties.
 * That gives downstream engines (slice 12's Tauri webview print) the
 * flexibility to inject overrides via a <style> tag without rewriting
 * the body.
 */
import type {
  BrandTokens,
  CategorySlot,
  DocDescriptor,
  PdfTemplateConfig,
} from "@founder-os/handoff-pack-core";

/**
 * Build the brand-applied CSS the document <head> includes. Pure
 * string; no fs, no Node modules.
 */
export function buildBrandCss(
  tokens: BrandTokens,
  config: PdfTemplateConfig
): string {
  const { colors, fonts } = tokens;
  return `
:root {
  --hp-color-primary: ${colors.primary};
  --hp-color-secondary: ${colors.secondary};
  --hp-color-background: ${colors.background};
  --hp-color-text: ${colors.text};
  --hp-font-heading: ${cssFontStack(fonts.heading)};
  --hp-font-body: ${cssFontStack(fonts.body)};
  --hp-font-mono: ${cssFontStack(fonts.mono)};
  --hp-page-margin-top: ${config.margins.topMm}mm;
  --hp-page-margin-right: ${config.margins.rightMm}mm;
  --hp-page-margin-bottom: ${config.margins.bottomMm}mm;
  --hp-page-margin-left: ${config.margins.leftMm}mm;
  --hp-header-height: ${config.headerHeightMm}mm;
  --hp-footer-height: ${config.footerHeightMm}mm;
}

@page {
  size: ${config.pageSize};
  margin: var(--hp-page-margin-top) var(--hp-page-margin-right)
          var(--hp-page-margin-bottom) var(--hp-page-margin-left);
}

body {
  font-family: var(--hp-font-body);
  color: var(--hp-color-text);
  background: var(--hp-color-background);
  font-size: 11pt;
  line-height: 1.5;
  margin: 0;
}

header.hp-page-header {
  border-bottom: 2px solid var(--hp-color-primary);
  padding: 0 0 6mm 0;
  margin-bottom: 8mm;
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  font-family: var(--hp-font-heading);
  color: var(--hp-color-primary);
}

header.hp-page-header .hp-company-name {
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-size: 10pt;
}

header.hp-page-header .hp-doc-category {
  font-weight: 500;
  font-size: 9pt;
  color: var(--hp-color-secondary);
  text-transform: uppercase;
}

footer.hp-page-footer {
  border-top: 2px solid var(--hp-color-primary);
  padding: 4mm 0 0 0;
  margin-top: 12mm;
  display: flex;
  justify-content: space-between;
  font-size: 8pt;
  color: var(--hp-color-secondary);
  font-family: var(--hp-font-body);
}

h1, h2, h3, h4, h5, h6 {
  font-family: var(--hp-font-heading);
  color: var(--hp-color-primary);
  margin-top: 1.2em;
  margin-bottom: 0.6em;
}

h1 { font-size: 24pt; margin-top: 0; }
h2 {
  font-size: 16pt;
  ${
    config.accentH2Underline
      ? "border-bottom: 1px solid var(--hp-color-primary); padding-bottom: 2mm;"
      : ""
  }
}
h3 { font-size: 13pt; }

p { margin: 0.6em 0; }
strong { color: var(--hp-color-primary); font-weight: 700; }
em { font-style: italic; }
code, pre {
  font-family: var(--hp-font-mono);
  background: rgba(0, 0, 0, 0.04);
  border-radius: 2px;
}
code { padding: 0 4px; }
pre {
  padding: 6mm;
  margin: 1em 0;
  font-size: 9pt;
  white-space: pre-wrap;
  word-wrap: break-word;
}

ul, ol { margin: 0.6em 0; padding-left: 1.6em; }
li { margin: 0.2em 0; }

a { color: var(--hp-color-primary); text-decoration: underline; }
hr {
  border: 0;
  border-top: 1px solid var(--hp-color-secondary);
  margin: 1.4em 0;
}

.hp-todo {
  background: color-mix(in srgb, var(--hp-color-primary) 8%, transparent);
  color: var(--hp-color-primary);
  border: 1px dashed var(--hp-color-primary);
  border-radius: 3px;
  padding: 0 4px;
  font-family: var(--hp-font-mono);
  font-size: 9pt;
}

.hp-confidentiality-note {
  font-style: italic;
}
`.trim();
}

/**
 * Wrap a rendered HTML fragment in the branded document shell. The
 * fragment is the markdown-engine output of the template body --
 * already escaped, no further sanitization needed here.
 */
export type WrapHtmlOpts = {
  /** Final HTML body fragment (markdown-derived). */
  bodyHtml: string;
  descriptor: DocDescriptor;
  tokens: BrandTokens;
  config: PdfTemplateConfig;
};

export function wrapBrandedHtml(opts: WrapHtmlOpts): string {
  const { bodyHtml, descriptor, tokens, config } = opts;
  const css = buildBrandCss(tokens, config);
  const headerLabel = humanCategoryLabel(descriptor.category);
  const renderedAt = new Date().toISOString().slice(0, 10);
  const confidentialitySuffix = config.footerConfidentialityNote.trim()
    ? ` <span class="hp-confidentiality-note">${escapeAttr(
        config.footerConfidentialityNote
      )}</span>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeAttr(descriptor.title)} -- ${escapeAttr(tokens.companyName)}</title>
<style>
${css}
</style>
</head>
<body>
<header class="hp-page-header">
  <span class="hp-company-name">${escapeAttr(tokens.companyName)}</span>
  <span class="hp-doc-category">${escapeAttr(headerLabel)}</span>
</header>
<main class="hp-doc-body">
${bodyHtml}
</main>
<footer class="hp-page-footer">
  <span class="hp-doc-meta">${escapeAttr(descriptor.title)} v1.0 -- ${renderedAt} -- (c) ${escapeAttr(tokens.companyName)}${confidentialitySuffix}</span>
  <span class="hp-page-of">Page 1 of 1</span>
</footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cssFontStack(family: string): string {
  // Avoid duplicate quoting if the caller already quoted it. Append
  // a sensible fallback so the PDF engine has something even if the
  // primary face isn't installed on the rendering host.
  const trimmed = family.replace(/^['"]|['"]$/g, "");
  return `"${trimmed}", "Helvetica Neue", Arial, sans-serif`;
}

function humanCategoryLabel(category: CategorySlot): string {
  // "03-design-brand" -> "Design and Brand". Cheap heuristic; if a
  // slot's slug stops being readable we move this into the manifest.
  const slug = category.replace(/^\d+-/, "").replace(/-/g, " ");
  return slug
    .split(" ")
    .map((w) => (w.length === 0 ? "" : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/\bAnd\b/g, "and");
}

const ATTR_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ATTR_ESCAPES[c] ?? c);
}
