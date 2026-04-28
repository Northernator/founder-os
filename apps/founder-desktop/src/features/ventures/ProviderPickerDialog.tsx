import { type LlmProviderId, PROVIDER_CATALOG, getProvider } from "@founder-os/llm-providers";
import { Button } from "@founder-os/ui";
/**
 * ProviderPickerDialog — modal that asks which LLM to use for a
 * generation action. Used by the brand-pack and logo-candidate flows,
 * designed to be reused anywhere multiple providers can service the
 * same request.
 *
 * Selection rules:
 *  - Only *usable* providers appear. For API-key rows that means
 *    enabled + apiKey present. For subscription rows that means enabled
 *    + mode='subscription' (the vendor CLI is assumed installed/signed
 *    in — the send itself will surface the vendor's error if not).
 *  - Claude is pre-selected when usable; otherwise the venture's
 *    default_provider; otherwise the first usable row in catalog order.
 *  - "Remember for this venture" checkbox persists the pick into
 *    ventures.default_provider on confirm. Unchecked → one-shot choice.
 *  - Transport badge (PRO / API) on each row so the user can tell
 *    subscription-routed traffic from API-billed traffic at a glance.
 *
 * The dialog is controlled — parent owns open/close state. `onConfirm`
 * receives the picked provider id; parent is responsible for passing
 * it into the generation call.
 */
import React, { useEffect, useState } from "react";
import * as db from "../../lib/db.js";

export type ProviderPickerResult = {
  providerId: LlmProviderId;
  remember: boolean;
};

type Props = {
  isOpen: boolean;
  ventureId: string;
  /** Dialog heading — phrased as a question. e.g. "Which AI should generate the logo?" */
  title: string;
  /** Optional subtitle / context for the pick. */
  description?: string;
  onCancel: () => void;
  onConfirm: (result: ProviderPickerResult) => void;
};

type UsableRow = {
  id: LlmProviderId;
  displayName: string;
  mode: "api_key" | "subscription";
  /** User-visible hint shown under the provider name. */
  hint: string;
};

export function ProviderPickerDialog({
  isOpen,
  ventureId,
  title,
  description,
  onCancel,
  onConfirm,
}: Props) {
  const [rows, setRows] = useState<UsableRow[]>([]);
  const [picked, setPicked] = useState<LlmProviderId | null>(null);
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(true);

  // Reset + hydrate when the dialog opens. We re-query every open so the
  // list reflects the current enabled/keyed state — a user who flipped a
  // provider since the last generation sees an accurate picker.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [settings, venturePref] = await Promise.all([
          db.listLlmSettings(),
          db.getVentureProvider(ventureId),
        ]);
        if (cancelled) return;

        const usable: UsableRow[] = [];
        for (const p of PROVIDER_CATALOG) {
          const s = settings.find((x) => x.provider === p.id);
          if (!s?.enabled) continue;
          if (s.mode === "subscription") {
            usable.push({
              id: p.id,
              displayName: p.displayName,
              mode: "subscription",
              hint: `${p.displayName} — subscription (vendor CLI)`,
            });
          } else {
            if (p.requiresApiKey && !s.apiKey) continue;
            usable.push({
              id: p.id,
              displayName: p.displayName,
              mode: "api_key",
              hint: `${p.displayName} — API key`,
            });
          }
        }

        setRows(usable);

        // Default selection precedence: venture pref > Claude > first usable.
        const preferredId: LlmProviderId | null =
          venturePref && usable.some((r) => r.id === venturePref)
            ? (venturePref as LlmProviderId)
            : usable.some((r) => r.id === "anthropic")
              ? "anthropic"
              : (usable[0]?.id ?? null);
        setPicked(preferredId);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, ventureId]);

  async function handleConfirm() {
    if (!picked) return;
    if (remember) {
      // Fire-and-wait: if the pref write fails (disk full, etc.), we
      // still proceed with the generation — a missing preference is a
      // cosmetic miss, not a blocker.
      try {
        await db.setVentureProvider(ventureId, picked);
      } catch (err) {
        console.warn("[brand] setVentureProvider failed", err);
      }
    }
    onConfirm({ providerId: picked, remember });
  }

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="provider-picker-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(17, 24, 39, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => {
        // Click on backdrop = cancel. Clicks inside the panel get
        // stopPropagation below so they don't close.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        style={{
          background: "#FFFFFF",
          width: 480,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 64px)",
          borderRadius: 12,
          boxShadow: "0 20px 50px rgba(17, 24, 39, 0.25)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "18px 20px 10px" }}>
          <h3 id="provider-picker-title" style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
            {title}
          </h3>
          {description && (
            <p
              style={{
                margin: "6px 0 0",
                fontSize: 13,
                color: "#6B7280",
                lineHeight: 1.5,
              }}
            >
              {description}
            </p>
          )}
        </div>

        <div
          style={{
            padding: "8px 20px 16px",
            overflow: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {loading ? (
            <div style={{ padding: 24, color: "#9CA3AF", fontSize: 13 }}>Checking providers…</div>
          ) : rows.length === 0 ? (
            <div
              role="alert"
              style={{
                padding: 16,
                background: "#FEF2F2",
                border: "1px solid #FECACA",
                color: "#991B1B",
                borderRadius: 6,
                fontSize: 13,
                lineHeight: 1.5,
              }}
            >
              No providers are set up yet. Open the Options tab to sign in to a subscription or
              paste an API key, then try again.
            </div>
          ) : (
            rows.map((row) => (
              <ProviderRow
                key={row.id}
                row={row}
                checked={picked === row.id}
                onPick={() => setPicked(row.id)}
              />
            ))
          )}
        </div>

        {rows.length > 0 && (
          <div
            style={{
              padding: "0 20px 12px",
              fontSize: 12,
              color: "#4B5563",
            }}
          >
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span>Remember this choice for this venture</span>
            </label>
          </div>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "12px 20px 16px",
            borderTop: "1px solid #E5E7EB",
            background: "#F9FAFB",
          }}
        >
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={handleConfirm} disabled={!picked || loading}>
            Generate with {picked ? providerShortName(picked) : "…"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ProviderRow({
  row,
  checked,
  onPick,
}: {
  row: UsableRow;
  checked: boolean;
  onPick: () => void;
}) {
  const catalog = getProvider(row.id);
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 14px",
        border: `1px solid ${checked ? "#6366F1" : "#E5E7EB"}`,
        background: checked ? "#EEF2FF" : "#FFFFFF",
        borderRadius: 8,
        cursor: "pointer",
        transition: "background 0.12s, border-color 0.12s",
      }}
    >
      <input
        type="radio"
        name="provider-pick"
        checked={checked}
        onChange={onPick}
        style={{ cursor: "pointer" }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 14,
            fontWeight: 600,
            color: "#111827",
          }}
        >
          {providerShortName(row.id)}
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              padding: "1px 5px",
              borderRadius: 3,
              background: row.mode === "subscription" ? "#ECFDF5" : "#EEF2FF",
              color: row.mode === "subscription" ? "#047857" : "#4338CA",
              letterSpacing: 0.3,
            }}
          >
            {row.mode === "subscription" ? "PRO" : "API"}
          </span>
        </div>
        <div
          style={{
            marginTop: 2,
            fontSize: 12,
            color: "#6B7280",
            lineHeight: 1.4,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {catalog.blurb}
        </div>
      </div>
    </label>
  );
}

/** Friendly short name for a provider id — matches the chat bubble caption
 *  map so the UI is consistent. Kept inline (not imported) because this
 *  component shouldn't depend on chat-ui. */
function providerShortName(id: string): string {
  const labels: Record<string, string> = {
    anthropic: "Claude",
    openai: "ChatGPT",
    gemini: "Gemini",
    deepseek: "DeepSeek",
    grok: "Grok",
    kimi: "Kimi",
    perplexity: "Perplexity",
    ollama: "Ollama",
  };
  return labels[id] ?? id.slice(0, 1).toUpperCase() + id.slice(1);
}
