/**
 * @founder-os/markdown-vault public entry -- CLIENT-SAFE.
 *
 * Slice 7 of the DREAM_VAULT_MODULE arc. Renders the 11 vault note
 * templates into markdown + frontmatter, sanitises the body, and hands
 * the bytes to an injectable `VaultFsPort` so the renderer can wire a
 * Tauri-command-backed port and tests can use an in-memory stub.
 */

export {
  MarkdownVaultError,
  type VaultFsPort,
  type WriteVaultNoteInput,
  type WriteVaultNoteResult,
} from "./types";

export {
  renderVaultTemplate,
  type TemplateContext,
  type TemplateRenderResult,
} from "./engine";

export {
  BRAND_REFERENCE_TEMPLATE,
  CHAT_SUMMARY_TEMPLATE,
  DECISION_LOG_TEMPLATE,
  DOCUMENT_SUMMARY_TEMPLATE,
  IMAGE_NOTE_TEMPLATE,
  PROJECT_INDEX_TEMPLATE,
  PROMPT_PACK_TEMPLATE,
  RAW_ARCHIVE_TEMPLATE,
  RESEARCH_NOTE_TEMPLATE,
  TASK_LIST_TEMPLATE,
  UI_REFERENCE_TEMPLATE,
  VAULT_NOTE_TEMPLATES,
  VAULT_TEMPLATE_VERSION,
  getVaultTemplate,
} from "./templates";

export {
  decodeFrontmatter,
  encodeFrontmatter,
} from "./frontmatter";

export { sanitiseVaultMarkdown, type SanitiseResult } from "./sanitiser";

export {
  NOTE_TYPE_TO_PROJECT_DIR,
  NOTE_TYPE_TO_UNSORTED_BUCKET,
  resolveVaultNoteDir,
  resolveVaultNotePath,
  toWorkspaceRelative,
} from "./paths";

export {
  createMemoryFsPort,
  renderVaultNoteContent,
  writeVaultNote,
} from "./write";
