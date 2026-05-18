/**
 * Slice-2 proof template -- a tier-D stub the renderPdfStep can drive
 * end-to-end without needing the slice-3 packages/handoff-pack-templates/
 * tree to exist yet.
 *
 * Mirrors the on-disk template that slice 3 will write at
 *   packages/handoff-pack-templates/04-engineering/08-coding-standards.md.hbs
 * (the `coding-standards` descriptor in handoff-pack-core/src/manifest.ts).
 *
 * CLIENT-SAFE -- pure string literal, no fs reads. Once slice 3 lands
 * the actual on-disk templates this constant moves to a vitest fixture
 * and the renderer reads from the templates package by default. The
 * signature of renderPdfStep keeps accepting either {templateSource}
 * or {templatePath} so callers stay stable.
 */
import type { DocDescriptor } from "@founder-os/handoff-pack-core";

/**
 * The doc descriptor we render in slice 2's end-to-end smoke. Mirrors
 * the entry slice 1 wrote in handoff-pack-core/src/manifest.ts:
 *   { id: "coding-standards", category: "04-engineering", slot: "08",
 *     tier: "D", roles: ["dev", "contractor"], sourceStages: [],
 *     placeholders: ["COMPANY_NAME", "COMPANY_SLUG", "CURRENT_DATE"] }
 *
 * Kept inline (not re-imported) so slice 2 tests can drive the
 * renderer without booting the whole manifest. The fields match
 * the manifest entry to within a typecheck.
 */
export const SLICE_2_PROOF_DESCRIPTOR: DocDescriptor = {
  id: "coding-standards",
  category: "04-engineering",
  slot: "08",
  title: "Coding Standards",
  description:
    "Formatting, naming, linting, comments, patterns.",
  tier: "D",
  roles: ["dev", "contractor"],
  sourceStages: [],
  templatePath: "04-engineering/08-coding-standards.md.hbs",
  placeholders: ["COMPANY_NAME", "COMPANY_SLUG", "CURRENT_DATE"],
};

/**
 * The proof template body. Handlebars-subset markdown -- the template
 * engine handles {{var}} substitution and the markdown-engine handles
 * the # / ## / lists / bold / italics rendering.
 *
 * Tier-D pattern: every section is either a literal sentence or a
 * `TODO: founder fills` callout. Slice 6+ rewrites several of these
 * to be LLM-generated; the slot stays the same.
 */
export const SLICE_2_PROOF_TEMPLATE = `# Coding Standards

This document records the coding standards every contributor to
**{{COMPANY_NAME}}** ({{COMPANY_SLUG}}) is expected to follow. It is
read at onboarding and reviewed at every release.

Last updated: **{{CURRENT_DATE}}**.

## Why these standards exist

Consistent code is easier to read, easier to review, and easier to
hand off when teams change. These rules are not a matter of taste --
they are the price of admission for being able to ship together.

## Languages and frameworks

- {{TODO_LANGUAGES}}
- {{TODO_FRAMEWORKS}}

## Formatting

The repo's formatter is canonical. If the formatter changes a line,
the formatter wins. Manual reformatting in a separate commit is
discouraged.

1. Run the formatter before pushing.
2. Run the linter before opening a pull request.
3. Treat formatter / linter failures in CI as a blocker.

## Naming

- Variables, functions, and files use the conventions of the host
  language.
- Names describe *what* a thing is, not *how* it works internally.
- Avoid abbreviations except where they are universal (e.g. \`url\`,
  \`id\`, \`db\`).

## Comments

Comments explain **why**, not what. The code already says what it
does. Comments that restate the code add maintenance burden without
adding signal.

## Review

- Every change goes through a pull request.
- The author is responsible for getting their change reviewed.
- Review is for *correctness, security, and clarity*, in that order.

---

> TODO: founder fills any company-specific rules that aren't covered
> by the canonical formatter / linter config. See
> \`04-engineering/09-git-workflow.md.hbs\` for the related branching
> rules.
`;
