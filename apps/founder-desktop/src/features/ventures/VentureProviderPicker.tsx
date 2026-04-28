import { type LlmProviderId, PROVIDER_CATALOG, getProvider } from "@founder-os/llm-providers";
import { Card } from "@founder-os/ui";
/**
 * Per-venture provider picker — lives on the Overview tab.
 *
 * Reads / writes `ventures.default_provider`. When set, this wins over the
 * global `app_settings.active_provider` for all chat and fix-suggestion
 * calls scoped to this venture (see `pickActiveProvider(ventureId)`).
 *
 * "Use default" is the null state — stored as NULL in SQLite, shown as the
 * first option in the dropdown.
 */
import React, { useCallback, useEffect, useState } from "react";
import * as db from "../../lib/db.js";

type Props = {
  ventureId: string;
};

export function VentureProviderPicker({ ventureId }: Props) {
  const [override, setOverride] = useState<string | null>(null);
  const [globalActive, setGlobalActive] = useState<string | null>(null);
  const [eligible, setEligible] = useState<LlmProviderId[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      // Pull the three bits in parallel — all small queries.
      const [vPref, gActive, settings] = await Promise.all([
        db.getVentureProvider(ventureId),
        db.getAppSetting(db.ACTIVE_PROVIDER_KEY),
        db.listLlmSettings(),
      ]);
      const usable = settings
        .filter((s) => {
          if (!s.enabled) return false;
          const c = getProvider(s.provider as LlmProviderId);
          if (c.requiresApiKey && !s.apiKey) return false;
          return true;
        })
        .map((s) => s.provider as LlmProviderId);
      setOverride(vPref);
      setGlobalActive(gActive);
      setEligible(usable);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [ventureId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleChange = async (next: string) => {
    setSaving(true);
    setErr(null);
    try {
      // Empty string in the <select> means "clear the override".
      const nextVal = next === "" ? null : next;
      await db.setVentureProvider(ventureId, nextVal);
      setOverride(nextVal);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // Work out what "default" resolves to right now, so the user knows what
  // picking "Use default" will actually do.
  const defaultLabel = globalActive
    ? `Default (${getProvider(globalActive as LlmProviderId).displayName})`
    : "Default (no global provider set — will pick first enabled)";

  return (
    <Card title="AI provider for this venture">
      <div style={{ fontSize: 13, color: "#6B7280", marginBottom: 10 }}>
        Override which LLM runs chat and fix-suggestions for this venture. Leave on <em>Default</em>{" "}
        to follow the global Options tab setting.
      </div>
      {loading ? (
        <div style={{ fontSize: 12, color: "#9CA3AF" }}>Loading…</div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <select
            value={override ?? ""}
            onChange={(e) => void handleChange(e.target.value)}
            disabled={saving}
            style={{
              padding: "6px 10px",
              fontSize: 13,
              border: "1px solid #D1D5DB",
              borderRadius: 6,
              background: "#FFFFFF",
              minWidth: 260,
            }}
          >
            <option value="">{defaultLabel}</option>
            {PROVIDER_CATALOG.map((p) => {
              const isEligible = eligible.includes(p.id);
              return (
                <option key={p.id} value={p.id} disabled={!isEligible}>
                  {p.displayName}
                  {isEligible ? "" : " (not configured)"}
                </option>
              );
            })}
          </select>
          {saving && <span style={{ fontSize: 12, color: "#9CA3AF" }}>saving…</span>}
          {override && !saving && (
            <button
              type="button"
              onClick={() => void handleChange("")}
              style={{
                background: "none",
                border: "none",
                color: "#6366F1",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                padding: 0,
              }}
            >
              Clear override
            </button>
          )}
        </div>
      )}
      {err && <div style={{ marginTop: 8, fontSize: 12, color: "#B91C1C" }}>{err}</div>}
    </Card>
  );
}
