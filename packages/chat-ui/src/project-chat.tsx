import type { VentureStage } from "@founder-os/domain";
import type React from "react";
import { useEffect, useRef, useState } from "react";

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

/**
 * Sizing knobs for the composer textarea. Defaults match the original
 * single-line composer so existing call sites are unchanged; pass larger
 * values when mounting the composer in a dedicated full-width section.
 */
export type ComposerSizing = {
  /** `rows` attribute on the textarea. Default 1. */
  rows?: number;
  /** Minimum textarea height in px. Default 44 (matches button row). */
  minHeight?: number;
  /** Maximum textarea height in px before vertical scroll. Default 120. */
  maxHeight?: number;
};

/**
 * Props shared by both `<ProjectChat>` (when it renders its own composer)
 * and the standalone `<ProjectChatComposer>` export. Extracted so the
 * standalone composer can be mounted in a different layout slot — e.g.
 * a tall, full-width input panel above/below the message stream — while
 * `<ProjectChat>` renders only the header + messages (pass
 * `hideComposer={true}` to suppress its built-in composer in that case).
 */
export type ProjectChatComposerProps = ComposerSizing & {
  isLoading?: boolean;
  onSend: (content: string) => void | Promise<void>;
  placeholder?: string;
  attachments?: ChatAttachment[];
  onAttach?: (files: FileList) => void | Promise<void>;
  onRemoveAttachment?: (id: string) => void;
  /** `accept` attribute for the file input. Default: common text + docx + pdf. */
  attachmentAccept?: string;
  /**
   * Outer wrapper styling. Defaults to the original composer chrome
   * (white background, top border, 12/20 padding). Pass a custom style
   * to flush the composer into a different container, e.g. a tall input
   * panel with its own border / background.
   */
  containerStyle?: React.CSSProperties;
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
  /**
   * Suppress the built-in composer at the bottom of the chat. Used when
   * the parent wants to mount `<ProjectChatComposer>` in its own
   * dedicated layout slot (e.g. a tall full-width input panel) so the
   * chat body itself shows only header + scrolling messages.
   */
  hideComposer?: boolean;
  /** Sizing overrides forwarded to the built-in composer when it's shown. */
  composerSizing?: ComposerSizing;
  /**
   * Suppress the built-in venture-name + stage-badge header at the top
   * of the chat. Used when the parent already surfaces this info in its
   * own surrounding chrome (e.g. a sidebar header) so the chat body
   * doesn't duplicate it.
   */
  hideHeader?: boolean;
};

export function ProjectChat({
  // biome-ignore lint/correctness/noUnusedVariables: kept for future use / interface compatibility
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
  hideComposer = false,
  composerSizing,
  hideHeader = false,
}: ProjectChatProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally omitted
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
      {/* Header — suppressed when the parent already surfaces venture
          name + stage in its own surrounding chrome (e.g. sidebar). */}
      {!hideHeader && (
        <div
          style={{
            padding: "14px 20px",
            borderBottom: "1px solid #E5E7EB",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 15, color: "#111827" }}>{ventureName}</span>
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
      )}

      {/* Messages — horizontal padding trimmed from 20px to 10px so
          the bubbles (capped at 94% width above) get more usable line
          length inside narrow sidebar columns. Vertical padding kept
          generous for breathing room. */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px 10px",
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

      {/* Built-in composer — suppressed when the parent mounts
          <ProjectChatComposer> in its own dedicated layout slot. */}
      {!hideComposer && (
        <ProjectChatComposer
          isLoading={isLoading}
          onSend={onSend}
          placeholder={placeholder}
          attachments={attachments}
          onAttach={onAttach}
          onRemoveAttachment={onRemoveAttachment}
          attachmentAccept={attachmentAccept}
          rows={composerSizing?.rows}
          minHeight={composerSizing?.minHeight}
          maxHeight={composerSizing?.maxHeight}
        />
      )}
    </div>
  );
}

/**
 * Standalone composer — the textarea + paperclip + Send row that normally
 * lives at the bottom of `<ProjectChat>`. Exported so the parent can mount
 * it in a different layout slot (e.g. a full-width input panel above or
 * beside the message stream). Owns its own `input` state so the parent
 * doesn't have to lift it; calls `onSend` with the trimmed text exactly
 * like the built-in composer does.
 *
 * Pair with `<ProjectChat hideComposer={true}>` to avoid rendering the
 * composer twice.
 */
export function ProjectChatComposer({
  isLoading = false,
  onSend,
  placeholder = "Ask anything about your venture…",
  attachments,
  onAttach,
  onRemoveAttachment,
  attachmentAccept = ".md,.txt,.json,.docx,.pdf,text/markdown,text/plain,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  rows = 1,
  minHeight = 44,
  maxHeight = 120,
  containerStyle,
}: ProjectChatComposerProps) {
  const [input, setInput] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const attachmentsEnabled = typeof onAttach === "function";
  const hasPendingExtraction = (attachments ?? []).some((a) => a.status === "pending");
  const hasReadyAttachment = (attachments ?? []).some((a) => a.status === "ready");
  const sendDisabled =
    isLoading || hasPendingExtraction || (!input.trim() && !hasReadyAttachment);

  const handleSend = async () => {
    const trimmed = input.trim();
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
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // In tall-composer mode (rows > 1) Enter inserts a newline; Cmd/Ctrl+Enter
    // sends. In compact mode (rows === 1) the original behavior is preserved:
    // Enter sends, Shift+Enter inserts a newline.
    if (rows > 1) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSend();
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      style={{
        padding: "12px 20px",
        borderTop: "1px solid #E5E7EB",
        background: "#FFFFFF",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        ...containerStyle,
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
          {attachments?.map((att) => (
            <AttachmentChip
              key={att.id}
              attachment={att}
              onRemove={onRemoveAttachment ? () => onRemoveAttachment(att.id) : undefined}
            />
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        {/* Hidden file input — kept in the DOM so the paperclip button
            (now on the right side, next to Send) can trigger it. */}
        {attachmentsEnabled && (
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={attachmentAccept}
            style={{ display: "none" }}
            onChange={handleFilesSelected}
          />
        )}

        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={rows}
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
            minHeight,
            maxHeight,
          }}
        />

        {/* Right-side action column — paperclip + Send live on the
            same side as each other. In compact (rows=1) mode they sit
            inline next to the textarea; in tall (rows>1) mode they
            stack vertically along the right edge of the textarea so the
            paperclip doesn't steal horizontal space from the typing
            area. Both buttons are slim square icons (~36px) in tall
            mode — Send shows an up-arrow rather than the word "Send" so
            the column is half the width it used to be. */}
        <div
          style={{
            display: "flex",
            flexDirection: rows > 1 ? "column" : "row",
            gap: 6,
            alignSelf: rows > 1 ? "stretch" : "auto",
            justifyContent: rows > 1 ? "flex-end" : "auto",
            flex: "0 0 auto",
            width: rows > 1 ? 36 : "auto",
          }}
        >
          {attachmentsEnabled && (
            <button
              type="button"
              onClick={handleFileButtonClick}
              disabled={isLoading}
              aria-label="Attach files"
              title="Attach .md, .txt, .json, .docx or .pdf"
              style={{
                width: rows > 1 ? 36 : 44,
                minWidth: rows > 1 ? 36 : 44,
                height: 36,
                minHeight: 36,
                background: "#F9FAFB",
                color: "#4B5563",
                border: "1px solid #D1D5DB",
                borderRadius: 8,
                fontSize: 14,
                lineHeight: 1,
                cursor: isLoading ? "not-allowed" : "pointer",
                opacity: isLoading ? 0.5 : 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flex: "0 0 auto",
                padding: 0,
              }}
            >
              📎
            </button>
          )}
          <button
            type="button"
            onClick={handleSend}
            disabled={sendDisabled}
            aria-label={rows > 1 ? "Send (Cmd/Ctrl+Enter)" : "Send (Enter)"}
            title={rows > 1 ? "Send (Cmd/Ctrl+Enter)" : "Send (Enter)"}
            style={{
              width: rows > 1 ? 36 : "auto",
              minWidth: rows > 1 ? 36 : 0,
              height: rows > 1 ? 36 : "auto",
              padding: rows > 1 ? 0 : "10px 18px",
              background: "#6366F1",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              fontWeight: 700,
              fontSize: rows > 1 ? 18 : 14,
              lineHeight: 1,
              cursor: sendDisabled ? "not-allowed" : "pointer",
              opacity: sendDisabled ? 0.5 : 1,
              minHeight: rows > 1 ? 36 : 44,
              flex: rows > 1 ? "0 0 auto" : "0 0 auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {/* Up-arrow icon in tall mode; plain "Send" text in compact
                mode so legacy inline-composer call sites are unchanged. */}
            {rows > 1 ? "↑" : "Send"}
          </button>
        </div>
      </div>
      {rows > 1 && (
        <div
          style={{
            fontSize: 10,
            color: "#9CA3AF",
            lineHeight: 1.3,
          }}
        >
          Enter for newline · Cmd/Ctrl+Enter to send
        </div>
      )}
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
  const kb =
    attachment.size >= 1024 ? `${Math.round(attachment.size / 1024)} KB` : `${attachment.size} B`;
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
  return PROVIDER_LABELS[id] ?? id.slice(0, 1).toUpperCase() + id.slice(1);
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  // Only assistant messages carry a provider caption — user turns don't
  // have one and legacy rows have provider:null. Suppress the caption
  // gracefully in both cases so the UI doesn't get chatty.
  const showCaption = !isUser && message.role === "assistant" && Boolean(message.provider);
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
          // Bumped from 75% -> 94% so assistant turns aren't aggressively
          // wrapped in the narrow 320px sidebar. The slight gap left at
          // the edge still keeps user/assistant alignment readable.
          maxWidth: "94%",
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
          {/*
            Transport badge -- per-message indicator showing whether the
            assistant turn was routed via subscription CLI (free under
            user's Pro/Plus/Advanced plan) or HTTP API (billed against
            the saved API key on the spot). The amber on API matches the
            ProviderModeBadge component used in the venture header so
            both surfaces speak the same visual language. The wording is
            deliberately explicit ("SUB" / "API", not "PRO" / "API") --
            "PRO" was ambiguous between Claude Pro the consumer plan and
            "pro" as in advanced, and the user has asked for the
            transport identity to be unmissable everywhere it appears.
          */}
          {message.providerMode === "subscription" && (
            <span
              title="Routed via subscription CLI -- no API charges"
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
              SUB
            </span>
          )}
          {message.providerMode === "api_key" && (
            <span
              title="Routed via HTTP API -- billed to your saved key"
              style={{
                fontSize: 9,
                fontWeight: 600,
                padding: "1px 5px",
                borderRadius: 3,
                background: "#FEF3C7",
                color: "#B45309",
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
