import {
  type LlmProviderCatalogEntry,
  type LlmProviderId,
  PROVIDER_CATALOG,
  getProvider,
} from "@founder-os/llm-providers";
import { type CacheStats, inspectCache } from "@founder-os/prompt-master";
import { Button, Card } from "@founder-os/ui";
import { invoke } from "@tauri-apps/api/core";
/**
 * Options tab — paste API keys for any of the supported LLM providers and pick
 * one as the active provider for chat. Settings live in the `llm_settings` +
 * `app_settings` SQLite tables; this screen is the only thing that writes to
 * them.
 *
 * UX principles:
 *  - Show every catalog provider up-front so the user sees the full menu,
 *    not just "Anthropic" until they dig.
 *  - Keys are masked by default with a reveal toggle — users paste them so
 *    rarely that a full-width mask is annoying, but an always-visible key is
 *    a bad default.
 *  - "Save" is explicit; fields are local until clicked. A user half-typing
 *    a key and switching ventures shouldn't persist gibberish.
 *  - The active-provider dropdown is capped to *enabled, fully-configured*
 *    providers so a user can't pick one that will fail on first send.
 */
import React, { useEffect, useState } from "react";
import * as db from "../../lib/db.js";
import { streamChat } from "../../lib/llm-client.js";
import {
  type SharedConfig,
  readSharedConfig,
  writeSharedConfig,
} from "../../lib/prompt-master-config.js";
import { useTheme } from "../../lib/theme.js";
import { pushToast } from "../../lib/toasts.js";
import { ThemeToggle } from "../chrome/ThemeToggle.js";
import { SubscriptionsSection } from "./SubscriptionsSection.js";

/** Wire payload for `pm_event_stats` in src-tauri/src/cache.rs.
 *  Field names line up with the Rust side's serde rename_all=camelCase.
 *
 *  topVentures excludes rows where venture_id IS NULL — events emitted
 *  before migration 0009 (and global-scope events) live on in the table
 *  but don't appear here.
 *
 *  Dollar fields are estimates from migration 0010 onward — Rust
 *  multiplies (provider, model) buckets by their input list price (see
 *  src-tauri/src/pricing.rs, mirrored from
 *  packages/llm-providers/src/pricing.ts). Pre-0010 events with NULL
 *  provider/model land in a midrange fallback bucket so they don't
 *  render as $0 in the UI. */
type EventStats = {
  lifetimeTokensSaved: number;
  totalEvents: number;
  cacheHitRate: number;
  topContexts: Array<{
    context: string;
    tokensSaved: number;
    count: number;
    dollarsSaved: number;
  }>;
  topVentures: Array<{
    ventureId: string;
    tokensSaved: number;
    events: number;
    dollarsSaved: number;
  }>;
  estimatedDollarsSavedLifetime: number;
  topVenturesByDollars: Array<{
    ventureId: string;
    dollarsSaved: number;
    tokensSaved: number;
    events: number;
  }>;
  topModelsByDollars: Array<{
    provider: string;
    model: string;
    dollarsSaved: number;
    tokensSaved: number;
    events: number;
  }>;
};

type ProviderFormState = {
  apiKey: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  /** Mirrors what's in the DB. Used to show "Unsaved changes" + revert. */
  saved: db.LlmSetting | null;
  revealKey: boolean;
  /** UI state for the per-row Test button. */
  testing: boolean;
  testResult: { ok: boolean; message: string } | null;
  dirty: boolean;
};

function emptyForm(catalog: LlmProviderCatalogEntry): ProviderFormState {
  return {
    apiKey: "",
    baseUrl: catalog.defaultBaseUrl,
    model: catalog.defaultModel,
    enabled: false,
    saved: null,
    revealKey: false,
    testing: false,
    testResult: null,
    dirty: false,
  };
}

function hydrateForm(catalog: LlmProviderCatalogEntry, saved: db.LlmSetting): ProviderFormState {
  return {
    apiKey: saved.apiKey ?? "",
    baseUrl: saved.baseUrl ?? catalog.defaultBaseUrl,
    model: saved.model || catalog.defaultModel,
    enabled: saved.enabled,
    saved,
    revealKey: false,
    testing: false,
    testResult: null,
    dirty: false,
  };
}

export function OptionsTab() {
  const [forms, setForms] = useState<Record<LlmProviderId, ProviderFormState>>(
    () =>
      Object.fromEntries(PROVIDER_CATALOG.map((p) => [p.id, emptyForm(p)])) as Record<
        LlmProviderId,
        ProviderFormState
      >
  );
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [hydrating, setHydrating] = useState(true);
  const [globalError, setGlobalError] = useState<string | null>(null);

  // Initial load — pull everything from SQLite and hydrate forms in one pass.
  useEffect(() => {
    (async () => {
      try {
        const [settings, active] = await Promise.all([
          db.listLlmSettings(),
          db.getAppSetting(db.ACTIVE_PROVIDER_KEY),
        ]);
        setForms((prev) => {
          const next = { ...prev };
          for (const s of settings) {
            const catalog = PROVIDER_CATALOG.find((p) => p.id === s.provider);
            if (!catalog) continue; // stale provider id — ignore
            next[catalog.id] = hydrateForm(catalog, s);
          }
          return next;
        });
        setActiveProvider(active);
      } catch (err) {
        setGlobalError(
          err instanceof Error ? err.message : `Failed to load settings: ${String(err)}`
        );
      } finally {
        setHydrating(false);
      }
    })();
  }, []);

  const patchForm = (id: LlmProviderId, patch: Partial<ProviderFormState>, markDirty = true) => {
    setForms((prev) => ({
      ...prev,
      [id]: {
        ...prev[id],
        ...patch,
        ...(markDirty ? { dirty: true, testResult: null } : {}),
      },
    }));
  };

  const handleSave = async (id: LlmProviderId) => {
    const catalog = getProvider(id);
    const form = forms[id];
    try {
      await db.upsertLlmSetting({
        provider: id,
        apiKey: form.apiKey.trim() ? form.apiKey.trim() : null,
        // Only persist a non-default base URL so the catalog default can
        // evolve without being pinned per-user. `null` in the DB = "use the
        // current default"; an explicit value = "pin this override".
        baseUrl:
          form.baseUrl.trim() && form.baseUrl.trim() !== catalog.defaultBaseUrl
            ? form.baseUrl.trim()
            : null,
        model: form.model.trim() || catalog.defaultModel,
        enabled: form.enabled,
      });
      const saved = await db.getLlmSetting(id);
      setForms((prev) => ({
        ...prev,
        [id]: {
          ...prev[id],
          saved,
          dirty: false,
        },
      }));
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : `Failed to save ${id}: ${String(err)}`);
    }
  };

  const handleRevert = (id: LlmProviderId) => {
    const catalog = getProvider(id);
    setForms((prev) => ({
      ...prev,
      // biome-ignore lint/style/noNonNullAssertion: value asserted non-null by surrounding logic
      [id]: prev[id].saved ? hydrateForm(catalog, prev[id].saved!) : emptyForm(catalog),
    }));
  };

  const handleClear = async (id: LlmProviderId) => {
    try {
      await db.deleteLlmSetting(id);
      const catalog = getProvider(id);
      setForms((prev) => ({ ...prev, [id]: emptyForm(catalog) }));
      if (activeProvider === id) {
        await db.setAppSetting(db.ACTIVE_PROVIDER_KEY, "");
        setActiveProvider(null);
      }
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : `Failed to clear ${id}: ${String(err)}`);
    }
  };

  const handleTest = async (id: LlmProviderId) => {
    patchForm(id, { testing: true, testResult: null }, false);
    try {
      // Cheap round-trip: one short prompt, small max_tokens. We don't stream
      // UI updates here — just confirm auth + network work.
      const text = await streamChat({
        provider: id,
        messages: [{ role: "user", content: "Say OK." }],
        maxTokens: 8,
      });
      patchForm(
        id,
        {
          testing: false,
          testResult: {
            ok: true,
            message: text.trim() ? `✓ ${text.trim().slice(0, 60)}` : "✓ connected",
          },
        },
        false
      );
    } catch (err) {
      patchForm(
        id,
        {
          testing: false,
          testResult: {
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          },
        },
        false
      );
    }
  };

  const handleSetActive = async (id: string) => {
    try {
      await db.setAppSetting(db.ACTIVE_PROVIDER_KEY, id);
      setActiveProvider(id);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : `Failed to set active: ${String(err)}`);
    }
  };

  // Only providers that are BOTH enabled AND fully-configured can be chosen as
  // the active one — a half-saved entry in the dropdown would fail on first send.
  // Subscription-mode rows skip the API-key check (the vendor CLI handles auth).
  const eligibleForActive = PROVIDER_CATALOG.filter((p) => {
    const f = forms[p.id];
    if (!f.saved?.enabled) return false;
    if (f.saved?.mode === "subscription") return true;
    if (p.requiresApiKey && !f.saved?.apiKey) return false;
    return true;
  });

  return (
    <div style={{ padding: 28, overflowX: "hidden", overflowY: "auto", height: "100%" }}>
      <AppearanceSection />

      <div style={{ height: 20 }} />

      <div style={{ marginBottom: 20 }}>
        <h3
          style={{ fontSize: 16, fontWeight: 700, margin: "0 0 6px", color: "var(--text-primary)" }}
        >
          AI providers
        </h3>
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
          Paste an API key for any provider you want to use. Keys stay on this machine — they live
          in the app's local SQLite database and are sent only to the provider's API. Ollama runs
          locally and needs no key.
        </p>
      </div>

      {globalError && (
        <div
          role="alert"
          style={{
            marginBottom: 16,
            padding: "10px 14px",
            background: "#FEF2F2",
            color: "#991B1B",
            border: "1px solid #FECACA",
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          {globalError}
        </div>
      )}

      <Card title="Active provider">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <select
            value={activeProvider ?? ""}
            onChange={(e) => handleSetActive(e.target.value)}
            disabled={eligibleForActive.length === 0}
            style={{
              padding: "8px 12px",
              borderRadius: 6,
              border: "1px solid #D1D5DB",
              fontSize: 14,
              background: "#FFFFFF",
              minWidth: 280,
            }}
          >
            <option value="" disabled>
              {eligibleForActive.length === 0
                ? "Save & enable a provider below"
                : "Choose a provider…"}
            </option>
            {eligibleForActive.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
          <span style={{ fontSize: 12, color: "#6B7280" }}>
            Used by the AI Chat tab for every new message.
          </span>
        </div>
      </Card>

      <div style={{ height: 20 }} />

      {/* Subscription-mode providers (Claude, ChatGPT, Gemini) via vendor
          CLIs. Rendered above the API-key grid because subscription mode
          is the preferred onboarding path for users who already pay for
          Claude Pro / ChatGPT Plus / Gemini Advanced. The section refreshes
          the Active-provider dropdown via `onChanged` when the user signs
          in or out. */}
      <SubscriptionsSection
        onChanged={() => {
          void (async () => {
            try {
              const [settings, active] = await Promise.all([
                db.listLlmSettings(),
                db.getAppSetting(db.ACTIVE_PROVIDER_KEY),
              ]);
              setForms((prev) => {
                const next = { ...prev };
                for (const s of settings) {
                  const catalog = PROVIDER_CATALOG.find((p) => p.id === s.provider);
                  if (!catalog) continue;
                  next[catalog.id] = hydrateForm(catalog, s);
                }
                return next;
              });
              setActiveProvider(active);
            } catch (err) {
              setGlobalError(
                err instanceof Error
                  ? err.message
                  : `Failed to reload after subscription change: ${String(err)}`
              );
            }
          })();
        }}
      />

      <div style={{ height: 20 }} />

      <EditorPreferenceCard />

      <div style={{ height: 20 }} />

      <PromptMasterSection />

      <div style={{ height: 20 }} />

      <div style={{ marginBottom: 12 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 4px" }}>API keys</h3>
        <p style={{ margin: 0, fontSize: 12, color: "#6B7280" }}>
          Use an API key from the provider's console. Usage is billed against your API account, not
          a consumer subscription. Keys are stored in your OS keychain.
        </p>
      </div>

      {hydrating ? (
        <div style={{ padding: 24, color: "#9CA3AF", fontSize: 14 }}>Loading settings…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {PROVIDER_CATALOG.map((catalog) => (
            <ProviderRow
              key={catalog.id}
              catalog={catalog}
              form={forms[catalog.id]}
              isActive={activeProvider === catalog.id}
              onPatch={(patch) => patchForm(catalog.id, patch)}
              onSave={() => handleSave(catalog.id)}
              onRevert={() => handleRevert(catalog.id)}
              onClear={() => handleClear(catalog.id)}
              onTest={() => handleTest(catalog.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Appearance — light / dark / grey / rainbow toggle exposed in Options
 * for users who never look at the title-bar widget. Reads the same
 * zustand store as the chrome toggle so the two stay in sync.
 */
function AppearanceSection() {
  const { theme } = useTheme();
  const themeLabel: Record<typeof theme, string> = {
    light: "Light",
    dark: "Dark",
    grey: "Grey",
    rainbow: "Rainbow",
  };
  return (
    <Card title="Appearance">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <ThemeToggle />
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
            Theme: {themeLabel[theme]}
          </span>
          <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
            Cycles light → dark → grey → rainbow. Shift-click in rainbow mode for warp speed.
          </span>
        </div>
      </div>
    </Card>
  );
}

function ProviderRow({
  catalog,
  form,
  isActive,
  onPatch,
  onSave,
  onRevert,
  onClear,
  onTest,
}: {
  catalog: LlmProviderCatalogEntry;
  form: ProviderFormState;
  isActive: boolean;
  onPatch: (patch: Partial<ProviderFormState>) => void;
  onSave: () => void;
  onRevert: () => void;
  onClear: () => void;
  onTest: () => void;
}) {
  return (
    <Card>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 16,
          marginBottom: 12,
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h4 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{catalog.displayName}</h4>
            {isActive && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  background: "#EEF2FF",
                  color: "#4338CA",
                  padding: "2px 8px",
                  borderRadius: 20,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                Active
              </span>
            )}
            {form.dirty && (
              <span style={{ fontSize: 11, color: "#B45309", fontWeight: 600 }}>
                Unsaved changes
              </span>
            )}
          </div>
          <p
            style={{
              margin: "4px 0 0",
              fontSize: 12,
              color: "#6B7280",
              lineHeight: 1.5,
            }}
          >
            {catalog.blurb}
          </p>
        </div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: "#374151",
          }}
        >
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => onPatch({ enabled: e.target.checked })}
          />
          Enabled
        </label>
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        {catalog.requiresApiKey && (
          <LabeledField label="API Key">
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type={form.revealKey ? "text" : "password"}
                value={form.apiKey}
                onChange={(e) => onPatch({ apiKey: e.target.value })}
                placeholder={`Paste your ${catalog.displayName} key`}
                style={inputStyle}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => onPatch({ revealKey: !form.revealKey })}
                style={secondaryButtonStyle}
              >
                {form.revealKey ? "Hide" : "Show"}
              </button>
              {catalog.apiKeyUrl && (
                <a
                  href={catalog.apiKeyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    ...secondaryButtonStyle,
                    textDecoration: "none",
                    display: "inline-flex",
                    alignItems: "center",
                  }}
                >
                  Get key ↗
                </a>
              )}
            </div>
          </LabeledField>
        )}

        <LabeledField
          label={`Base URL${form.baseUrl !== catalog.defaultBaseUrl ? " (overridden)" : ""}`}
        >
          <input
            value={form.baseUrl}
            onChange={(e) => onPatch({ baseUrl: e.target.value })}
            placeholder={catalog.defaultBaseUrl}
            style={inputStyle}
            spellCheck={false}
          />
        </LabeledField>

        <LabeledField label="Model">
          <input
            list={`${catalog.id}-models`}
            value={form.model}
            onChange={(e) => onPatch({ model: e.target.value })}
            placeholder={catalog.defaultModel}
            style={inputStyle}
            spellCheck={false}
          />
          <datalist id={`${catalog.id}-models`}>
            {catalog.modelSuggestions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </LabeledField>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 14,
          flexWrap: "wrap",
        }}
      >
        <Button variant="primary" size="sm" onClick={onSave} disabled={!form.dirty}>
          Save
        </Button>
        <Button variant="secondary" size="sm" onClick={onRevert} disabled={!form.dirty}>
          Revert
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={onTest}
          disabled={
            form.testing ||
            form.dirty ||
            !form.saved?.enabled ||
            (catalog.requiresApiKey && !form.saved?.apiKey)
          }
        >
          {form.testing ? "Testing…" : "Test connection"}
        </Button>
        <button
          type="button"
          onClick={onClear}
          disabled={!form.saved}
          style={{
            padding: "6px 12px",
            background: "transparent",
            color: form.saved ? "#B91C1C" : "#D1D5DB",
            border: "none",
            fontSize: 12,
            fontWeight: 600,
            cursor: form.saved ? "pointer" : "not-allowed",
          }}
        >
          Clear
        </button>
        {form.testResult && (
          <span
            style={{
              fontSize: 12,
              color: form.testResult.ok ? "#047857" : "#B91C1C",
              marginLeft: 4,
              wordBreak: "break-word",
              flex: 1,
              minWidth: 200,
            }}
          >
            {form.testResult.message}
          </span>
        )}
      </div>
    </Card>
  );
}

function LabeledField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: "#6B7280" }}>{label}</span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid #D1D5DB",
  fontSize: 13,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  outline: "none",
  minWidth: 0,
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  border: "1px solid #D1D5DB",
  background: "#FFFFFF",
  color: "#374151",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

// ──────────────────────────────────────────────
// Editor preference card
//
// Lets the user override the built-in editor candidate chain (`code`,
// `cursor`, `windsurf`, `codium` + OS install dirs) with a specific binary
// or full custom command. Persisted in `app_settings` via db.setEditorCommand.
// Consumed by the Rust `open_in_editor` command — see editor.rs for the
// resolution rules.
//
// Three categories of preset to keep the common path one click:
//   - Auto-detect (no override)
//   - Known editors (code/cursor/windsurf/codium)
//   - Custom command (free text, supports {path} placeholder)
// ──────────────────────────────────────────────

type EditorMode = "auto" | "code" | "cursor" | "windsurf" | "codium" | "custom";

const EDITOR_PRESETS: {
  mode: Exclude<EditorMode, "auto" | "custom">;
  label: string;
  command: string;
}[] = [
  { mode: "code", label: "VS Code", command: "code" },
  { mode: "cursor", label: "Cursor", command: "cursor" },
  { mode: "windsurf", label: "Windsurf", command: "windsurf" },
  { mode: "codium", label: "VSCodium", command: "codium" },
];

/** Convert a stored DB value back into mode + custom-text state. */
function decodeStored(value: string | null): { mode: EditorMode; custom: string } {
  if (!value) return { mode: "auto", custom: "" };
  const preset = EDITOR_PRESETS.find((p) => p.command === value);
  if (preset) return { mode: preset.mode, custom: "" };
  return { mode: "custom", custom: value };
}

function EditorPreferenceCard() {
  const [hydrating, setHydrating] = useState(true);
  const [savedValue, setSavedValue] = useState<string | null>(null);
  const [mode, setMode] = useState<EditorMode>("auto");
  const [custom, setCustom] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const value = await db.getEditorCommand();
        const { mode: m, custom: c } = decodeStored(value);
        setSavedValue(value);
        setMode(m);
        setCustom(c);
      } catch (err) {
        // Hydration failures are silent here — the toast surface will catch
        // them via db.ts side-effects, and the field defaults to Auto-detect
        // which is safe.
        console.warn("[options] editor pref hydrate failed", err);
      } finally {
        setHydrating(false);
      }
    })();
  }, []);

  // What value WOULD be persisted if Save was clicked right now? Used both
  // by the Save handler and by the "Unsaved changes" indicator.
  const pendingValue = ((): string | null => {
    if (mode === "auto") return null;
    if (mode === "custom") {
      const trimmed = custom.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    const preset = EDITOR_PRESETS.find((p) => p.mode === mode);
    return preset?.command ?? null;
  })();

  const dirty = pendingValue !== savedValue;

  const handleSave = async () => {
    setSaving(true);
    try {
      await db.setEditorCommand(pendingValue);
      setSavedValue(pendingValue);
      pushToast({
        kind: "success",
        message: pendingValue
          ? `Editor set to ${describeValue(pendingValue)}`
          : "Editor set to auto-detect",
      });
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Couldn't save editor preference",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleRevert = () => {
    const { mode: m, custom: c } = decodeStored(savedValue);
    setMode(m);
    setCustom(c);
  };

  // "code" → "VS Code", or echo a custom string verbatim. Used for toast text.
  const describeValue = (v: string): string => {
    const preset = EDITOR_PRESETS.find((p) => p.command === v);
    return preset ? preset.label : v;
  };

  return (
    <Card title="Editor">
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "#6B7280", lineHeight: 1.5 }}>
        Used by the “Open in editor” button on Audit findings. Auto-detect tries VS Code, Cursor,
        Windsurf, then VSCodium in turn — pick a specific one if you want to skip that chain, or
        supply a custom command to launch any editor that takes a file path on the command line.
      </p>

      {hydrating ? (
        <div style={{ padding: 8, color: "#9CA3AF", fontSize: 13 }}>Loading…</div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as EditorMode)}
              style={{
                padding: "8px 12px",
                borderRadius: 6,
                border: "1px solid #D1D5DB",
                fontSize: 14,
                background: "#FFFFFF",
                minWidth: 220,
              }}
            >
              <option value="auto">Auto-detect (default)</option>
              {EDITOR_PRESETS.map((p) => (
                <option key={p.mode} value={p.mode}>
                  {p.label} ({p.command})
                </option>
              ))}
              <option value="custom">Custom command…</option>
            </select>
            {dirty && (
              <span style={{ fontSize: 11, color: "#B45309", fontWeight: 600 }}>
                Unsaved changes
              </span>
            )}
          </div>

          {mode === "custom" && (
            <div style={{ marginBottom: 12 }}>
              <input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder={`e.g. notepad++ -multiInst "{path}"`}
                style={{ ...inputStyle, width: "100%" }}
                spellCheck={false}
                autoComplete="off"
              />
              <p
                style={{
                  margin: "6px 0 0",
                  fontSize: 11,
                  color: "#6B7280",
                  lineHeight: 1.5,
                }}
              >
                Use <code>{"{path}"}</code> as the placeholder for the file path. If omitted, the
                path is appended as the last argument. The line is shell-evaluated, so quoting works
                the way it does in your terminal.
              </p>
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Button variant="primary" size="sm" onClick={handleSave} disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleRevert}
              disabled={!dirty || saving}
            >
              Revert
            </Button>
            <span style={{ fontSize: 12, color: "#6B7280", marginLeft: 4 }}>
              Saved: <code style={{ fontSize: 12 }}>{savedValue ?? "auto-detect"}</code>
            </span>
          </div>
        </>
      )}
    </Card>
  );
}

function PromptMasterSection() {
  const [config, setConfig] = React.useState<SharedConfig | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Live stats. `null` = not yet loaded; defensively-zeroed values
  // arrive on cache or invoke failure (the wrappers swallow). The
  // refresh handler also re-runs both fetches in parallel — they're
  // independent and the inspect path is one SQL query.
  const [cacheStats, setCacheStats] = React.useState<CacheStats | null>(null);
  const [eventStats, setEventStats] = React.useState<EventStats | null>(null);
  const [loadingStats, setLoadingStats] = React.useState(true);
  // Venture id → name map for the "Top ventures" panel. Built from
  // db.listVentures and refreshed alongside stats so a venture renamed
  // mid-session shows the new name on the next tick. A venture deleted
  // since events were logged falls back to the raw id.
  const [ventureNamesById, setVentureNamesById] = React.useState<Record<string, string>>({});

  const refreshStats = React.useCallback(async () => {
    // Don't blank the existing values while refreshing — that would
    // make the auto-refresh tick look like a flicker. Errors are
    // logged but never surface as a card-level error because both
    // backends are best-effort by contract.
    try {
      const [cs, es, ventures] = await Promise.all([
        inspectCache(),
        invoke<EventStats>("pm_event_stats"),
        db.listVentures(),
      ]);
      setCacheStats(cs);
      setEventStats(es);
      setVentureNamesById(Object.fromEntries(ventures.map((v) => [v.id, v.name])));
    } catch (err) {
      console.warn("[options] prompt-master stats refresh failed", err);
    } finally {
      setLoadingStats(false);
    }
  }, []);

  React.useEffect(() => {
    void (async () => {
      try {
        const c = await readSharedConfig();
        setConfig(c);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  // Initial fetch + auto-refresh while the tab is visible. The
  // OptionsTab is unmounted when the user switches tabs, so the
  // interval is tied to mount lifetime — but we additionally pause on
  // document.hidden to avoid burning a query when the whole window is
  // backgrounded. Polling at 30s keeps the numbers fresh-enough without
  // hammering SQLite while the user is mid-chat.
  React.useEffect(() => {
    void refreshStats();
    let timer: number | null = null;
    const start = () => {
      if (timer === null) {
        timer = window.setInterval(() => void refreshStats(), 30_000);
      }
    };
    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshStats]);

  const handleToggleStreaming = async (next: boolean) => {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      await writeSharedConfig({
        promptMaster: { ...config.promptMaster, streamingProgress: next },
      });
      setConfig({
        promptMaster: { ...config.promptMaster, streamingProgress: next },
      });
      pushToast({ kind: "success", message: "Prompt Master setting saved" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Prompt Master">
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <p style={{ margin: 0, fontSize: 13, color: "#374151", lineHeight: 1.5 }}>
          Lossless prompt optimizer wired into every system prompt the app sends - handoff agents,
          wireframe compiler, research extractor, venture chat. Uses your Claude CLI auth (no API
          key). Falls back to identity if the CLI isn't reachable, so nothing breaks.
        </p>

        <PromptMasterStats
          cacheStats={cacheStats}
          eventStats={eventStats}
          ventureNamesById={ventureNamesById}
          loading={loadingStats}
          onRefresh={() => void refreshStats()}
        />

        <div>
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              fontSize: 13,
              fontWeight: 600,
              color: "#374151",
              cursor: config && !saving ? "pointer" : "default",
            }}
          >
            <input
              type="checkbox"
              checked={config?.promptMaster.streamingProgress ?? false}
              disabled={!config || saving}
              onChange={(e) => void handleToggleStreaming(e.target.checked)}
              style={{ marginTop: 2, cursor: "inherit" }}
            />
            <span>
              Stream handoff progress
              <p
                style={{
                  margin: "4px 0 0",
                  fontWeight: 400,
                  fontSize: 12,
                  color: "#6B7280",
                  lineHeight: 1.5,
                }}
              >
                <strong>OFF (default):</strong> Fixed-percentage progress (20%, 50%, 95%). Lower
                overhead, works with any <code>claude</code> CLI version. Best for short handoffs
                and slower machines.
                <br />
                <strong>ON:</strong> Token-by-token progress parsed from{" "}
                <code>claude -p --output-format stream-json</code>. Smoother UX for long generations
                (build steps, audits). Requires a CLI version that supports stream-json output
                (Claude Code 2024+).
              </p>
            </span>
          </label>
        </div>

        {error && <p style={{ margin: 0, fontSize: 12, color: "#DC2626" }}>{error}</p>}
      </div>
    </Card>
  );
}

// ──────────────────────────────────────────────
// Prompt Master stats panel
//
// Two halves: cache (left) and optimisation (right). Wraps onto a
// single column under ~620px wide. Uses inline styles to match the
// rest of OptionsTab — the project doesn't load Tailwind for the
// desktop bundle, so "use existing Tailwind classes" maps to
// "match the existing inline-style vocabulary".
// ──────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/** Format a dollar amount for the savings card.
 *
 *  Returns null below 1¢ so the caller can hide the line entirely
 *  rather than render "$0.00" — early in the lifetime totals the
 *  number is a fraction of a cent and printing $0.00 makes Prompt
 *  Master look broken. Above 1¢ we show 2 decimals, which is what
 *  users expect for a USD value. */
function formatDollars(value: number): string | null {
  if (!Number.isFinite(value) || value < 0.01) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function PromptMasterStats({
  cacheStats,
  eventStats,
  ventureNamesById,
  loading,
  onRefresh,
}: {
  cacheStats: CacheStats | null;
  eventStats: EventStats | null;
  /** Venture id → display name. Empty when the list hasn't loaded yet
   *  or when a venture has been deleted since its events were logged.
   *  The Top ventures panel falls back to the raw id when missing. */
  ventureNamesById: Record<string, string>;
  loading: boolean;
  onRefresh: () => void;
}) {
  // Empty-state gate: no events yet means the user hasn't sent a
  // chat message since the migration ran, so the optimisation half
  // would all read zero. Showing a short hint instead of zeros makes
  // the empty case feel intentional.
  const isEmpty =
    !loading &&
    eventStats !== null &&
    eventStats.totalEvents === 0 &&
    (cacheStats?.entries ?? 0) === 0;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <label
          style={{
            display: "block",
            fontSize: 12,
            fontWeight: 600,
            color: "#374151",
          }}
        >
          Lifetime stats
        </label>
        <Button variant="secondary" size="sm" onClick={onRefresh} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {isEmpty ? (
        <p
          style={{
            margin: 0,
            padding: "12px 14px",
            background: "#F9FAFB",
            border: "1px solid #E5E7EB",
            borderRadius: 6,
            fontSize: 12,
            color: "#6B7280",
            lineHeight: 1.5,
          }}
        >
          No optimisations yet — send a chat message to start collecting data.
        </p>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 16,
          }}
        >
          <CacheStatsPanel stats={cacheStats} />
          <OptimisationStatsPanel stats={eventStats} ventureNamesById={ventureNamesById} />
        </div>
      )}
    </div>
  );
}

function CacheStatsPanel({ stats }: { stats: CacheStats | null }) {
  // The cap can legitimately be 0 (defensive zero return from the
  // backend on inspect failure). Guard division explicitly.
  const cap = stats?.capBytes ?? 0;
  const total = stats?.totalBytes ?? 0;
  const pct = cap > 0 ? Math.min(1, total / cap) : 0;

  return (
    <div
      style={{
        padding: 14,
        background: "#F9FAFB",
        border: "1px solid #E5E7EB",
        borderRadius: 6,
      }}
    >
      <h5
        style={{
          margin: "0 0 10px",
          fontSize: 11,
          fontWeight: 700,
          color: "#6B7280",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        Cache
      </h5>
      <StatRow label="Entries" value={stats ? formatNumber(stats.entries) : "—"} />
      <StatRow label="Size" value={stats ? formatBytes(total) : "—"} />
      <StatRow label="Cap" value={cap > 0 ? formatBytes(cap) : "—"} />
      <div style={{ marginTop: 10 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 11,
            color: "#6B7280",
            marginBottom: 4,
          }}
        >
          <span>{formatPercent(pct)} full</span>
          <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
            {stats ? `${formatBytes(total)} / ${cap > 0 ? formatBytes(cap) : "?"}` : ""}
          </span>
        </div>
        <div
          style={{
            height: 6,
            background: "#E5E7EB",
            borderRadius: 3,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${(pct * 100).toFixed(2)}%`,
              height: "100%",
              background: "#4338CA",
              transition: "width 200ms ease-out",
            }}
          />
        </div>
      </div>
    </div>
  );
}

function OptimisationStatsPanel({
  stats,
  ventureNamesById,
}: {
  stats: EventStats | null;
  ventureNamesById: Record<string, string>;
}) {
  return (
    <div
      style={{
        padding: 14,
        background: "#F9FAFB",
        border: "1px solid #E5E7EB",
        borderRadius: 6,
      }}
    >
      <h5
        style={{
          margin: "0 0 10px",
          fontSize: 11,
          fontWeight: 700,
          color: "#6B7280",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        Optimisation
      </h5>
      <div style={{ marginBottom: 10 }}>
        <div
          style={{
            fontSize: 24,
            fontWeight: 700,
            color: "#1F2937",
            // tabular-nums keeps the digits aligned across refreshes;
            // without it the number jitters horizontally as it grows.
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1.1,
          }}
        >
          {stats ? formatNumber(stats.lifetimeTokensSaved) : "—"}
        </div>
        <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2 }}>
          tokens saved (lifetime)
          {stats &&
            (() => {
              // Below 1¢ we hide the line — printing "$0.00" while
              // pricing data is still accumulating reads as broken
              // rather than precise. formatDollars already returns
              // null for that case.
              const dollars = formatDollars(stats.estimatedDollarsSavedLifetime);
              return dollars ? (
                <span
                  style={{
                    marginLeft: 6,
                    color: "#059669",
                    fontWeight: 600,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  (~{dollars})
                </span>
              ) : null;
            })()}
        </div>
      </div>
      <StatRow label="Cache hit rate" value={stats ? formatPercent(stats.cacheHitRate) : "—"} />
      <StatRow label="Total events" value={stats ? formatNumber(stats.totalEvents) : "—"} />
      <div style={{ marginTop: 10 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "#6B7280",
            marginBottom: 4,
          }}
        >
          Top contexts
        </div>
        {stats && stats.topContexts.length > 0 ? (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {stats.topContexts.map((c) => {
              const dollars = formatDollars(c.dollarsSaved);
              return (
                <li
                  key={c.context}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 12,
                    color: "#374151",
                  }}
                >
                  <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                    {c.context}
                  </span>
                  <span
                    style={{
                      color: "#6B7280",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {formatNumber(c.tokensSaved)} ({c.count})
                    {dollars && (
                      <span style={{ marginLeft: 6, fontSize: 10, color: "#059669" }}>
                        {dollars}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p style={{ margin: 0, fontSize: 12, color: "#9CA3AF" }}>—</p>
        )}
      </div>
      {stats && stats.topVentures.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "#6B7280",
              marginBottom: 4,
            }}
          >
            Top ventures
          </div>
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {stats.topVentures.map((v) => {
              // Resolve venture name; fall back to raw id when the
              // venture record has been deleted since its events were
              // logged. Tooltip carries the raw id either way so a
              // power user can grep for it without renaming a venture.
              const name = ventureNamesById[v.ventureId] ?? v.ventureId;
              const dollars = formatDollars(v.dollarsSaved);
              return (
                <li
                  key={v.ventureId}
                  title={v.ventureId}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 12,
                    color: "#374151",
                  }}
                >
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: "60%",
                    }}
                  >
                    {name}
                  </span>
                  <span
                    style={{
                      color: "#6B7280",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {formatNumber(v.tokensSaved)} ({v.events})
                    {dollars && (
                      <span style={{ marginLeft: 6, fontSize: 10, color: "#059669" }}>
                        {dollars}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {stats && stats.topModelsByDollars.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "#6B7280",
              marginBottom: 4,
            }}
          >
            Top models
          </div>
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {stats.topModelsByDollars.map((m) => {
              // Hide the dollar tail when sub-cent so the row collapses
              // to "<provider>/<model> N (events)" — same shape as the
              // contexts/ventures fallback. Most rows here have a real
              // dollar value because they're keyed off provider/model.
              const dollars = formatDollars(m.dollarsSaved);
              return (
                <li
                  key={`${m.provider}::${m.model}`}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 12,
                    color: "#374151",
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: "60%",
                    }}
                    title={`${m.provider}/${m.model}`}
                  >
                    {m.provider}/{m.model}
                  </span>
                  <span
                    style={{
                      color: "#6B7280",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {formatNumber(m.tokensSaved)} ({m.events})
                    {dollars && (
                      <span style={{ marginLeft: 6, fontSize: 10, color: "#059669" }}>
                        {dollars}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        fontSize: 12,
        color: "#374151",
        padding: "3px 0",
      }}
    >
      <span style={{ color: "#6B7280" }}>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{value}</span>
    </div>
  );
}
