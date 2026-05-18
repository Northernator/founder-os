/**
 * SupabaseCredentialsModal -- paste BYOP credentials + validate (slice 7).
 *
 * Renders three inputs (projectUrl + anonKey + serviceRoleKey), validates
 * via the backend_probe_supabase Tauri command, and on success persists
 * via backend_save_supabase_credentials. The keys never round-trip
 * through React state once the modal closes; only the projectUrl gets
 * mirrored into the venture manifest (committed to git -- safe).
 *
 * Read-back: when the modal opens we don\'t pre-populate the keys
 * (they\'re secrets) but we DO pre-populate projectUrl from the
 * manifest so the founder doesn\'t have to re-type it on every edit.
 */
import { useState } from "react";

import {
  probeSupabase,
  saveSupabaseCredentials,
} from "../../lib/backend-supabase.js";

type Props = {
  ventureRoot: string;
  initialProjectUrl: string;
  /**
   * Called when the modal saves a new projectUrl. The parent persists
   * it into venture.yaml under `backend.supabase.projectUrl` -- secrets
   * stay out of the manifest entirely.
   */
  onSaved: (projectUrl: string) => void;
  onClose: () => void;
};

type ValidationState =
  | { kind: "idle" }
  | { kind: "probing" }
  | { kind: "ok"; version: string }
  | { kind: "error"; reason: string };

export function SupabaseCredentialsModal({
  ventureRoot,
  initialProjectUrl,
  onSaved,
  onClose,
}: Props) {
  const [projectUrl, setProjectUrl] = useState(initialProjectUrl);
  const [anonKey, setAnonKey] = useState("");
  const [serviceRoleKey, setServiceRoleKey] = useState("");
  const [validation, setValidation] = useState<ValidationState>({ kind: "idle" });
  const [busy, setBusy] = useState(false);

  async function handleValidate() {
    setBusy(true);
    setValidation({ kind: "probing" });
    try {
      // Save first (so the env-var-named keys are on disk where the
      // CLI will read them), then probe. The probe also reads
      // process.env -- if the user has the keys exported in their
      // shell already, the save step is essentially a no-op duplicate.
      const saveResult = await saveSupabaseCredentials({
        ventureRoot,
        projectUrl,
        anonKey,
        serviceRoleKey,
      });
      if (!saveResult.saved) {
        setValidation({ kind: "error", reason: saveResult.reason });
        return;
      }
      const probeResult = await probeSupabase({
        ventureRoot,
        projectUrl,
      });
      if (!probeResult.available) {
        setValidation({ kind: "error", reason: probeResult.reason });
        return;
      }
      setValidation({ kind: "ok", version: probeResult.version });
      onSaved(projectUrl);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-label="Supabase credentials">
        <h3 style={{ margin: "0 0 8px" }}>Connect Supabase</h3>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 0 }}>
          Paste your project URL + service-role key from supabase.com. The
          keys are written to{" "}
          <code>12_backend/supabase/.credentials.json</code> (gitignored).
          They never get committed.
        </p>

        <label style={{ display: "block", marginTop: 12 }}>
          <span style={{ display: "block", fontSize: 12, marginBottom: 4 }}>
            Project URL
          </span>
          <input
            type="text"
            value={projectUrl}
            onChange={(e) => setProjectUrl(e.target.value)}
            placeholder="https://abc123.supabase.co"
            style={{ width: "100%" }}
          />
        </label>

        <label style={{ display: "block", marginTop: 12 }}>
          <span style={{ display: "block", fontSize: 12, marginBottom: 4 }}>
            Anon key
          </span>
          <input
            type="password"
            value={anonKey}
            onChange={(e) => setAnonKey(e.target.value)}
            placeholder="eyJ..."
            style={{ width: "100%" }}
          />
        </label>

        <label style={{ display: "block", marginTop: 12 }}>
          <span style={{ display: "block", fontSize: 12, marginBottom: 4 }}>
            Service-role key (secret -- never commit)
          </span>
          <input
            type="password"
            value={serviceRoleKey}
            onChange={(e) => setServiceRoleKey(e.target.value)}
            placeholder="eyJ..."
            style={{ width: "100%" }}
          />
        </label>

        <div style={{ marginTop: 16, minHeight: 24, fontSize: 13 }}>
          {validation.kind === "idle" && (
            <span style={{ color: "var(--text-secondary)" }}>
              Validation runs against /auth/v1/health.
            </span>
          )}
          {validation.kind === "probing" && (
            <span>Validating credentials...</span>
          )}
          {validation.kind === "ok" && (
            <span style={{ color: "var(--accent-success, green)" }}>
              ✓ Connected ({validation.version})
            </span>
          )}
          {validation.kind === "error" && (
            <span style={{ color: "var(--accent-danger, crimson)" }}>
              ✗ {validation.reason}
            </span>
          )}
        </div>

        <div
          style={{
            marginTop: 16,
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
          }}
        >
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleValidate}
            disabled={
              busy ||
              projectUrl.trim().length === 0 ||
              anonKey.trim().length === 0 ||
              serviceRoleKey.trim().length === 0
            }
          >
            {busy ? "Validating..." : "Validate + save"}
          </button>
        </div>
      </div>
    </div>
  );
}
