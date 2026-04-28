import React, { useState, useRef, useEffect } from "react";
import type { VentureStage } from "@founder-os/domain";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  /** Provider id ("anthropic", "openai", "gemini", etc.) used to generate
   *  this message. Only meaningful for assistant-role messages; user and
   *  system messages leave this undefined. The chat bubble renders this
   *  as "via Claude" / "via ChatGPT" / "via Gemini" under the bubble.
   *
   *  Nullable so legacy pre-0006 messages (and all user messages) render
   *  cleanly without a caption. */
  provider?: string | null;
  /** How the provider was reached: "api_key" | "subscription". Surfaces
   *  in the caption as "via API" vs "via Pro" so the user can tell
   *  subscription-routed traffic from API-billed traffic at a glance.
   *
   *  Nullable — pre-0006 messages and user messages leave this empty. */
  providerMode?: string | null;
};

/**
 * Attachment chip surfaced in the composer. The chat UI only renders the
 * chip — extraction (reading the file, docx→text via mammoth, etc.) lives
 * outside this package so we don't pull heavyweight deps into chat-ui.
 *
 * `status` drives the chip appearance: "pending" = still extracting,
 * "ready" = content available for send, "error" = extraction failed.
 */
export type ChatAttachment = {
  id: string;
  name: string;
  size: number;
  status: "pending" | "ready" | "error";
  /** Short error note shown on hover/next-to-chip when status = "error". */
  error?: string;
};

export type ProjectChatProps = {
  ventureId: string;
  ventureName: string;
  currentStage: VentureStage;
  messages: ChatMessage[];
  isLoading?: boolean;
  onSend: (content: string) => void | Promise<void>;
  placeholder?: string;
  /**
   * Attachment support. When these are supplied, a paperclip button
   * appears next to the composer. Omit all of them and the composer
   * stays a plain textarea (keeps existing call sites unchanged).
   */
  attachments?: ChatAttachment[];
  onAttach?: (files: FileList) => void | Promise<void>;
  onRemoveAttachment?: (id: string) => void;
  /** `accept` attribute for the file input. Default: common text + docx + pdf. */
  attachmentAccept?: string;
};

export function ProjectChat({
  ventureId,
  ventureName,
  currentStage,
  messages,
  isLoading = false,
  onSend,
  placeholder = "Ask anything about your venture…",
  attachments,
  onAttach,
  onRemoveAttachment,
  attachmentAccept = ".md,.txt,.json,.docx,.pdf,text/markdown,text/plain,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}: ProjectChatProps) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Whether the composer should show attachment affordances (chip strip +
  // paperclip button). Gated on onAttach being supplied so existing call
  // sites that don't pass attachment props keep their old plain composer.
  const attachmentsEnabled = typeof onAttach === "function";
  const hasPendingExtraction = (attachments ?? []).some(
    (a) => a.status === "pending"
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    const trimmed = input.trim();
    // Allow send with no text if there's at least one ready attachment —
    // the attachments themselves become the message (handleSend on the
    // outside concatenates extracted text). But block while any extraction
    // is still in flight so the model doesn't see a half-read docx.
    const hasReadyAttachment = (attachments ?? []).some(
      (a) => a.status === "ready"
    );
    if (isLoading || hasPendingExtraction) return;
    if (!trimmed && !hasReadyAttachment) return;
    setInput("");
    await onSend(trimmed);
  };

  const handleFileButtonClick = () => {
    fileInputRef.current?.click();
  };

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !onAttach) return;
    try {
      await onAttach(files);
    } finally {
      // Reset so selecting the same file again re-fires change.
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#FFFFFF",
        fontFamily: "Inter, sans-serif",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "14px 20px",
          borderBottom: "1px solid #E5E7EB",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 15, color: "#111827" }}>
          {ventureName}
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            background: "#EEF2FF",
            color: "#4338CA",
            padding: "2px 8px",
            borderRadius: 20,
          }}
        >
          {currentStage.replace(/_/g, " ")}
        </span>
      </div>

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "20px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {messages.length === 0 && (
          <div
            style={{
              textAlign: "center",
              color: "#9CA3AF",
              fontSize: 14,
              marginTop: 40,
            }}
          >
            Start a conversation about <strong>{ventureName}</strong>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {isLoading && (
          <div style={{ display: "flex", gap: 6, padding: "8px 0" }}>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: "#D1D5DB",
                  animation: `bounce 1s ease-in-out ${i * 0.15}s infinite`,
                }}
              />
            ))}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Composer (attachments strip + input row) */}
      <div
        style={{
          padding: "12px 20px",
          borderTop: "1px solid #E5E7EB",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {/* Attachment chips — rendered above the textarea so users see
            what's attached before they hit Send. Only shown when there's
            actually at least one chip so we don't add dead whitespace. */}
        {attachmentsEnabled && (attachments ?? []).length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
            }}
            aria-label="Attachments"
          >
            {attachments!.map((att) => (
              <AttachmentChip
                key={att.id}
                attachment={att}
                onRemove={
                  onRemoveAttachment ? () => onRemoveAttachment(att.id) : undefined
                }
              />
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 10 }}>
          {attachmentsEnabled && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={attachmentAccept}
                style={{ display: "none" }}
                onChange={handleFilesSelected}
              />
              <button
                type="button"
                onClick={handleFileButtonClick}
                disabled={isLoading}
                aria-label="Attach files"
                title="Attach .md, .txt, .json, .docx or .pdf"
                style={{
                  width: 44,
                  minHeight: 44,
                  background: "#F9FAFB",
                  color: "#4B5563",
                  border: "1px solid #D1D5DB",
                  borderRadius: 8,
                  fontSize: 18,
                  lineHeight: 1,
                  cursor: isLoading ? "not-allowed" : "pointer",
                  opacity: isLoading ? 0.5 : 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flex: "0 0 auto",
                }}
              >
                📎
              </button>
            </>
          )}

          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={1}
            style={{
              flex: 1,
              resize: "none",
              border: "1px solid #D1D5DB",
              borderRadius: 8,
              padding: "10px 14px",
              fontSize: 14,
              fontFamily: "inherit",
              outline: "none",
              lineHeight: 1.5,
              minHeight: 44,
              maxHeight: 120,
            }}
          />
          <button
            onClick={handleSend}
            disabled={
              isLoading ||
              hasPendingExtraction ||
              (!input.trim() &&
                !(attachments ?? []).some((a) => a.status === "ready"))
            }
            style={{
              padding: "10px 18px",
              background: "#6366F1",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              fontWeight: 600,
              fontSize: 14,
              cursor:
                isLoading ||
                hasPendingExtraction ||
                (!input.trim() &&
                  !(attachments ?? []).some((a) => a.status === "ready"))
                  ? "not-allowed"
                  : "pointer",
              opacity:
                isLoading ||
                hasPendingExtraction ||
                (!input.trim() &&
                  !(attachments ?? []).some((a) => a.status === "ready"))
                  ? 0.5
                  : 1,
            }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ChatAttachment;
  onRemove?: () => void;
}) {
  const isPending = attachment.status === "pending";
  const isError = attachment.status === "error";
  const bg = isError ? "#FEF2F2" : isPending ? "#FEF3C7" : "#EEF2FF";
  const fg = isError ? "#991B1B" : isPending ? "#92400E" : "#4338CA";
  const border = isError ? "#FECACA" : isPending ? "#FDE68A" : "#C7D2FE";
  const kb = attachment.size >= 1024 ? `${Math.round(attachment.size / 1024)} KB` : `${attachment.size} B`;
  return (
    <div
      title={attachment.error || attachment.name}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: bg,
        border: `1px solid ${border}`,
        color: fg,
        padding: "3px 8px",
        borderRadius: 14,
        fontSize: 12,
        lineHeight: 1.4,
        maxWidth: 240,
      }}
    >
      <span aria-hidden="true" style={{ flex: "0 0 auto" }}>
        {isError ? "✕" : isPending ? "⏳" : "📄"}
      </span>
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontWeight: 500,
        }}
      >
        {attachment.name}
      </span>
      <span style={{ opacity: 0.7, flex: "0 0 auto" }}>{kb}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${attachment.name}`}
          style={{
            background: "transparent",
            border: "none",
            color: fg,
            cursor: "pointer",
            fontSize: 12,
            lineHeight: 1,
            padding: 0,
            marginLeft: 2,
            flex: "0 0 auto",
            opacity: 0.7,
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

/**
 * Map internal provider id to a short display label for the "via …"
 * caption. Kept inline rather than imported from @founder-os/llm-providers
 * because chat-ui deliberately has zero runtime deps beyond React — we
 * don't want to pull the whole provider catalogue in just to label a
 * bubble. Unknown ids render as the raw id (capitalized) so a new
 * provider slips in without a chat-ui rebuild.
 */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Claude",
  openai: "ChatGPT",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  grok: "Grok",
  kimi: "Kimi",
  perplexity: "Perplexity",
  ollama: "Ollama",
};

function providerLabel(id: string): string {
  return (
    PROVIDER_LABELS[id] ??
    id.slice(0, 1).toUpperCase() + id.slice(1)
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  // Only assistant messages carry a provider caption — user turns don't
  // have one and legacy rows have provider:null. Suppress the caption
  // gracefully in both cases so the UI doesn't get chatty.
  const showCaption =
    !isUser && message.role === "assistant" && Boolean(message.provider);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: isUser ? "flex-end" : "flex-start",
        gap: 4,
      }}
    >
      <div
        style={{
          maxWidth: "75%",
          padding: "10px 14px",
          borderRadius: isUser ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
          background: isUser ? "#6366F1" : "#F3F4F6",
          color: isUser ? "#fff" : "#111827",
          fontSize: 14,
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {message.content}
      </div>
      {showCaption && (
        <div
          style={{
            fontSize: 11,
            color: "#9CA3AF",
            paddingLeft: 4,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span>via {providerLabel(message.provider as string)}</span>
          {message.providerMode === "subscription" && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 600,
                padding: "1px 5px",
                borderRadius: 3,
                background: "#ECFDF5",
                color: "#047857",
                letterSpacing: 0.3,
              }}
            >
              PRO
            </span>
          )}
          {message.providerMode === "api_key" && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 600,
                padding: "1px 5px",
                borderRadius: 3,
                background: "#EEF2FF",
                color: "#4338CA",
                letterSpacing: 0.3,
              }}
            >
              API
            </span>
          )}
        </div>
      )}
    </div>
  );
}
