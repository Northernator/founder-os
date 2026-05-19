/**
 * @founder-os/chat-importer public entry -- CLIENT-SAFE.
 *
 * Slice 4 of the DREAM_VAULT_MODULE arc. Four parsers + a markdown
 * renderer for the vault chat-summary template. Pure-TS; no node:*
 * imports.
 */

export {
  type ChatConversation,
  ChatConversationSchema,
  type ChatRole,
  ChatRoleSchema,
  type ChatTurn,
  ChatTurnSchema,
  ChatImporterError,
  type ParsedChat,
  ParsedChatSchema,
} from "./types";

export { parseChatGptExport } from "./chatgpt";
export {
  parseClaudeJsonExport,
  parseClaudeMarkdownExport,
} from "./claude";
export {
  type ParseGenericInput,
  looksLikeChatTranscript,
  parseGenericTranscript,
} from "./generic";
export { type ParsePastedInput, parsePastedText } from "./paste";
export { renderConversationToMarkdown } from "./render";
