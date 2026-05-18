/**
 * <PostizConfigModal> -- per-venture Postiz REST endpoint + API-key-env
 * picker.
 *
 * Mounted by <SocialActions> when:
 *   - manifest.social?.backend === "postiz" (the venture has opted into the
 *     hosted-tier backend), AND
 *   - the backend probe returns available:false (so the user can fix the
 *     config without leaving the modal), OR
 *   - the user explicitly clicks the "Configure Postiz" button.
 *
 * Persists to `manifest.social.postiz` on venture.yaml via
 * writeVentureManifest. The API key itself is NEVER persisted to disk --
 * the founder picks an env var NAME (default POSTIZ_API_KEY); the Node
 * sidecar reads `process.env[name]` at post time. This matches the
 * Supabase / CRM credential-handling pattern so secrets never leak into
 * tracked files.
 *
 * Slice 4 of the SOCIAL-MODULE follow-up arc.
 */
import {
  PostizConfigSchema,
  type PostizConfig,
  type SocialConfig,
} from "@founder-os/social-core";
import type { VentureManifest } from "@founder-os/domain";
import { useState } from "react";
import { writeVentureManifest } from "../../lib/venture-io.js";
import { pushToast } from "../../lib/toasts.js";

export type PostizConfigModalProps = {
  ventureRoot: string;
  manifest: VentureManifest;
  /** Existing values, pre-filled into the form. Empty values mean "ask for". */
  initial?: PostizConfig;
  onClose: () => void;
  onSaved: (next: VentureManifest) => void;
};

export function PostizConfigModal(props: PostizConfigModalProps) {
  const [baseUrl, setBaseUrl] = useState<string>(props.initial?.baseUrl ?? "");
  const [apiKeyEnvVar, setApiKeyEnvVar] = useState<string>(
    props.initial?.apiKeyEnvVar ?? "POSTIZ_API_KEY",
  );
  const [allowRemoteOnly, setAllowRemoteOnly] = useState<boolean>(
    props.initial?.allowRemoteOnly ?? false,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    // Parse via the schema so we get the same validation the Node sidecar
    // applies. Empty baseUrl is allowed (sp-poster fallback) but we surface
    // a hint so the user knows posting will fail until they set it.
    const parsed = PostizConfigSchema.safeParse({
      baseUrl: baseUrl.trim(),
      apiKeyEnvVar: apiKeyEnvVar.trim() || "POSTIZ_API_KEY",
      allowRemoteOnly,
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join("; "));
      return;
    }
    setSaving(true);
    try {
      const existingSocial: Partial<SocialConfig> = props.manifest.social ?? {};
      const nextManifest: VentureManifest = {
        ...props.manifest,
        social: {
          enabled: existingSocial.enabled ?? true,
          backend: existingSocial.backend ?? "postiz",
          enabledBackends:
            existingSocial.enabledBackends ?? ["social-poster", "postiz"],
          enabledPlatforms:
            existingSocial.enabledPlatforms ?? ["x", "linkedin", "bluesky"],
          ...(existingSocial["social-poster"] !== undefined
            ? { "social-poster": existingSocial["social-poster"] }
            : {}),
          postiz: parsed.data,
        },
      };
      await writeVentureManifest(props.ventureRoot, nextManifest);
      props.onSaved(nextManifest);
      pushToast({
        kind: "info",
        message: parsed.data.baseUrl
          ? `Postiz config saved (${parsed.data.baseUrl})`
          : "Postiz config saved -- set baseUrl before posting",
        ttlMs: 5000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) props.onClose();
      }}
    >
      <div
        style={{
          background: "var(--bg-base)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 10,
          padding: 20,
          width: "min(480px, 92vw)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>
            Configure Postiz
          </h2>
          <button
            type="button"
            onClick={props.onClose}
            disabled={saving}
            style={{
              padding: "4px 10px",
              background: "transparent",
              border: "1px solid var(--border-subtle)",
              color: "var(--text-secondary)",
              borderRadius: 6,
              fontSize: 12,
              cursor: saving ? "default" : "pointer",
            }}
          >
            Close
          </button>
        </div>

        <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          Postiz lets this venture post via official APIs (no Puppeteer cookies).
          You need a self-hosted Postiz instance reachable from this machine.
          The API key itself is read from an env var on the Node sidecar --
          we never write it to venture.yaml.
        </p>

        <Field
          label="Base URL"
          hint="https://postiz.example.com (no trailing slash). Leave blank to disable Postiz."
        >
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://postiz.example.com"
            disabled={saving}
            style={inputStyle}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field
          label="API key env var"
          hint="Name of the env var the sidecar reads at post time. Default POSTIZ_API_KEY."
        >
          <input
            type="text"
            value={apiKeyEnvVar}
            onChange={(e) => setApiKeyEnvVar(e.target.value)}
            placeholder="POSTIZ_API_KEY"
            disabled={saving}
            style={inputStyle}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-secondary)" }}>
          <input
            type="checkbox"
            checked={allowRemoteOnly}
            onChange={(e) => setAllowRemoteOnly(e.target.checked)}
            disabled={saving}
          />
          <span>
            Refuse non-local Postiz hosts (compliance guard). Off by default --
            most Postiz deploys live on a remote VPS.
          </span>
        </label>

        {error && (
          <div
            style={{
              padding: 8,
              border: "1px solid var(--danger, #c46161)",
              borderRadius: 6,
              fontSize: 12,
              color: "var(--danger, #c46161)",
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={props.onClose}
            disabled={saving}
            style={{
              padding: "8px 14px",
              background: "transparent",
              border: "1px solid var(--border-subtle)",
              color: "var(--text-secondary)",
              borderRadius: 6,
              fontSize: 13,
              cursor: saving ? "default" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: "8px 14px",
              background: saving ? "var(--bg-elevated)" : "var(--accent-soft)",
              border: `1px solid ${saving ? "var(--border-subtle)" : "var(--accent-soft)"}`,
              color: saving ? "var(--text-muted)" : "var(--accent-hover)",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              cursor: saving ? "default" : "pointer",
            }}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
        {label}
      </span>
      {children}
      {hint && (
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{hint}</span>
      )}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  fontFamily: "inherit",
  fontSize: 13,
  padding: "8px 10px",
  background: "var(--bg-elevated)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-subtle)",
  borderRadius: 6,
};
