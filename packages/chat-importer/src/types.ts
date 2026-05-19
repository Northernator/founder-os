import { ExtractionMethodSchema } from "@founder-os/vault-contract";
import { z } from "zod";

export const ChatRoleSchema = z.enum(["user", "assistant", "system", "tool", "other"]);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatTurnSchema = z.object({
  role: ChatRoleSchema,
  content: z.string(),
  /** ISO timestamp where the export carried one. */
  createdAt: z.string().optional(),
  /** Free-form provider-specific metadata; kept for debugging. */
  meta: z.record(z.unknown()).optional(),
});
export type ChatTurn = z.infer<typeof ChatTurnSchema>;

export const ChatConversationSchema = z.object({
  /** Provider-side conversation id where available; otherwise a synth slug. */
  id: z.string(),
  title: z.string(),
  turns: z.array(ChatTurnSchema),
  /** ISO timestamp of the conversation creation, where known. */
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type ChatConversation = z.infer<typeof ChatConversationSchema>;

export const ParsedChatSchema = z.object({
  /** The detected source format. */
  extractionMethod: ExtractionMethodSchema,
  conversations: z.array(ChatConversationSchema),
  /** Conversation-level + file-level parse warnings. */
  warnings: z.array(z.string()).default([]),
});
export type ParsedChat = z.infer<typeof ParsedChatSchema>;

export class ChatImporterError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ChatImporterError";
  }
}
