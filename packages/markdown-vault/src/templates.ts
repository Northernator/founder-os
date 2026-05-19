/**
 * Slice 7 -- inline vault note templates.
 *
 * The DREAM_VAULT spec §3 slice 7 lists 11 .md.hbs files. We ship them
 * as inline TS strings (rather than disk-resident .md.hbs files like
 * @founder-os/handoff-pack-templates) for two reasons:
 *
 *   1. The vault arc only has 11 templates, vs handoff-pack's 100+.
 *   2. Keeping them inline removes the Node-side "load template from
 *      disk" step so this package stays fully client-safe and the
 *      runner can render notes in-memory before writing.
 *
 * The placeholder syntax matches the renderVaultTemplate engine:
 *   {{var}}                    -- simple substitution
 *   {{#if var}}...{{/if}}      -- conditional
 *   {{#each list}}...{{/each}} -- iteration (current item is `this`)
 *   {{!-- comment --}}         -- stripped at render
 *
 * Each template documents its expected variables at the top via a
 * {{!-- comment --}} block so the runner / tests can audit them.
 */
import type { VaultNoteType } from "@founder-os/vault-contract";

/**
 * Monotonic version stamp for the vault note templates.
 *
 * Bumped whenever the rendered output of ANY template in this module
 * would change for the same variables. Persisted into
 * `vault_note_drafts.template_version` at the end of every run so
 * boot hydration can detect drafts produced by an older template
 * revision and force a re-render on resume rather than committing
 * stale markdown byte-for-byte.
 *
 * Rules of thumb for bumping:
 *   - Add a template     -> no bump (existing rows still render the same way)
 *   - Change frontmatter -> bump (changes every consumer of every template)
 *   - Change a body str  -> bump (changes rendered output for that template)
 *   - Fix a typo only    -> bump (output is byte-different)
 *   - Rename a variable  -> bump (old drafts will have an empty placeholder)
 *
 * Start at 1. Resumed drafts whose persisted version doesn't match
 * this constant are re-rendered through writeVaultNote() at finalize
 * time, so an older session's persisted previewContent never lands on
 * disk verbatim after a template change.
 */
export const VAULT_TEMPLATE_VERSION = 1;

// ---------------------------------------------------------------------------
// 00_index / project_index
// ---------------------------------------------------------------------------

export const PROJECT_INDEX_TEMPLATE = `{{!-- vars: projectName, projectSlug, createdAt, lastImportedAt, recentImports[] (title, importedAt, sourceType) --}}
# {{projectName}} -- Vault Index

_Slug:_ \`{{projectSlug}}\`
_Created:_ {{createdAt}}
{{#if lastImportedAt}}_Last import:_ {{lastImportedAt}}{{/if}}

## Recent imports

{{#each recentImports}}
- **{{title}}** ({{sourceType}}) -- imported {{importedAt}}
{{/each}}

{{!-- end project_index --}}
`;

// ---------------------------------------------------------------------------
// 10_chat-summaries / chat_summary
// ---------------------------------------------------------------------------

export const CHAT_SUMMARY_TEMPLATE = `{{!-- vars: chatTitle, chatProvider, chatDate?, turnCount, summary, keyDecisions[], keyTasks[], transcript --}}
# {{chatTitle}}

_Provider:_ {{chatProvider}}
{{#if chatDate}}_Date:_ {{chatDate}}{{/if}}
_Turn count:_ {{turnCount}}

## Summary

{{summary}}

{{#if keyDecisions}}
## Key decisions

{{#each keyDecisions}}
- **{{title}}** -- {{content}}
{{/each}}
{{/if}}

{{#if keyTasks}}
## Key tasks

{{#each keyTasks}}
- **{{title}}** -- {{content}}
{{/each}}
{{/if}}

## Transcript

{{transcript}}
`;

// ---------------------------------------------------------------------------
// 20_document-summaries / document_summary
// ---------------------------------------------------------------------------

export const DOCUMENT_SUMMARY_TEMPLATE = `{{!-- vars: docTitle, docMime?, docOriginalName, summary, keyFacts[], markdown? --}}
# {{docTitle}}

_Original filename:_ \`{{docOriginalName}}\`
{{#if docMime}}_MIME:_ {{docMime}}{{/if}}

## Summary

{{summary}}

{{#if keyFacts}}
## Key facts

{{#each keyFacts}}
- **{{title}}** -- {{content}}
{{/each}}
{{/if}}

{{#if markdown}}
## Extracted content

{{markdown}}
{{/if}}
`;

// ---------------------------------------------------------------------------
// 20_document-summaries / image_note (images share the docs dir)
// ---------------------------------------------------------------------------

export const IMAGE_NOTE_TEMPLATE = `{{!-- vars: imageTitle, width?, height?, ocrText?, visionSummary?, tags[] --}}
# {{imageTitle}}

{{#if width}}_Dimensions:_ {{width}} x {{height}} px{{/if}}

{{#if visionSummary}}
## Vision summary

{{visionSummary}}
{{/if}}

{{#if ocrText}}
## OCR text

\`\`\`
{{ocrText}}
\`\`\`
{{/if}}

{{#if tags}}
## Tags

{{#each tags}}
- {{this}}
{{/each}}
{{/if}}
`;

// ---------------------------------------------------------------------------
// 30_decisions / decision_log
// ---------------------------------------------------------------------------

export const DECISION_LOG_TEMPLATE = `{{!-- vars: entryTitle, decisionMade, rationale?, relatedItems[] (title, content) --}}
# {{entryTitle}}

## Decision

{{decisionMade}}

{{#if rationale}}
## Rationale

{{rationale}}
{{/if}}

{{#if relatedItems}}
## Related

{{#each relatedItems}}
- **{{title}}** -- {{content}}
{{/each}}
{{/if}}
`;

// ---------------------------------------------------------------------------
// 40_tasks / task_list
// ---------------------------------------------------------------------------

export const TASK_LIST_TEMPLATE = `{{!-- vars: listTitle, tasks[] (title, content, status) --}}
# {{listTitle}}

{{#each tasks}}
- [{{status}}] **{{title}}** -- {{content}}
{{/each}}
`;

// ---------------------------------------------------------------------------
// 50_prompts / prompt_pack
// ---------------------------------------------------------------------------

export const PROMPT_PACK_TEMPLATE = `{{!-- vars: packTitle, prompts[] (title, content, kind?) --}}
# {{packTitle}}

{{#each prompts}}
## {{title}}

{{#if kind}}_Kind:_ {{kind}}{{/if}}

\`\`\`
{{content}}
\`\`\`
{{/each}}
`;

// ---------------------------------------------------------------------------
// 60_research / research_note
// ---------------------------------------------------------------------------

export const RESEARCH_NOTE_TEMPLATE = `{{!-- vars: noteTitle, topic?, findings[] (title, content), sources?[] (title, url?) --}}
# {{noteTitle}}

{{#if topic}}_Topic:_ {{topic}}{{/if}}

## Findings

{{#each findings}}
- **{{title}}** -- {{content}}
{{/each}}

{{#if sources}}
## Sources

{{#each sources}}
- {{title}}{{#if url}} -- {{url}}{{/if}}
{{/each}}
{{/if}}
`;

// ---------------------------------------------------------------------------
// 70_brand-references / brand_reference
// ---------------------------------------------------------------------------

export const BRAND_REFERENCE_TEMPLATE = `{{!-- vars: refTitle, palette?, fonts?, descriptions[] --}}
# {{refTitle}}

{{#if palette}}
## Palette

{{palette}}
{{/if}}

{{#if fonts}}
## Fonts

{{fonts}}
{{/if}}

{{#if descriptions}}
## Notes

{{#each descriptions}}
- {{this}}
{{/each}}
{{/if}}
`;

// ---------------------------------------------------------------------------
// 80_ui-references / ui_reference
// ---------------------------------------------------------------------------

export const UI_REFERENCE_TEMPLATE = `{{!-- vars: refTitle, imagePath?, notes?, components[] --}}
# {{refTitle}}

{{#if imagePath}}![reference]({{imagePath}}){{/if}}

{{#if notes}}
## Notes

{{notes}}
{{/if}}

{{#if components}}
## Components

{{#each components}}
- {{this}}
{{/each}}
{{/if}}
`;

// ---------------------------------------------------------------------------
// 90_raw-archive / raw_archive
// ---------------------------------------------------------------------------

export const RAW_ARCHIVE_TEMPLATE = `{{!-- vars: archiveTitle, rawMarkdown --}}
# {{archiveTitle}}

{{!-- Raw extracted markdown, preserved verbatim for audit. --}}

{{rawMarkdown}}
`;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const VAULT_NOTE_TEMPLATES: ReadonlyMap<VaultNoteType, string> = new Map<
  VaultNoteType,
  string
>([
  ["project_index", PROJECT_INDEX_TEMPLATE],
  ["chat_summary", CHAT_SUMMARY_TEMPLATE],
  ["document_summary", DOCUMENT_SUMMARY_TEMPLATE],
  ["image_note", IMAGE_NOTE_TEMPLATE],
  ["decision_log", DECISION_LOG_TEMPLATE],
  ["task_list", TASK_LIST_TEMPLATE],
  ["prompt_pack", PROMPT_PACK_TEMPLATE],
  ["research_note", RESEARCH_NOTE_TEMPLATE],
  ["brand_reference", BRAND_REFERENCE_TEMPLATE],
  ["ui_reference", UI_REFERENCE_TEMPLATE],
  ["raw_archive", RAW_ARCHIVE_TEMPLATE],
]);

export function getVaultTemplate(noteType: VaultNoteType): string {
  const tpl = VAULT_NOTE_TEMPLATES.get(noteType);
  if (!tpl) {
    throw new Error(`no vault template registered for noteType="${noteType}"`);
  }
  return tpl;
}
