/**
 * VaultImportLocalScreen -- pick local files for the Dream Vault.
 *
 * Uses @tauri-apps/plugin-dialog to open the native file/folder picker.
 * Once the user confirms a selection the screen calls onStartImport with
 * a normalised array of VaultImportSourceInput rows + a stable job id
 * the progress screen will key its log polling against.
 */
import type { SourceDocument } from "@founder-os/vault-contract";
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { normalizeDialogPath } from "../normalize-dialog-path.js";
import { PrivacyBanner } from "./VaultImportHubScreen.js";
import type { VaultImportSourceInput } from "../run-vault-import.js";

export type VaultImportLocalScreenProps = {
  onBack: () => void;
  onStartImport: (sources: StagedSourcePreview[], jobId: string) => void;
};

/** What the progress screen receives -- mirrors VaultImportSourceInput. */
export type StagedSourcePreview = VaultImportSourceInput;

function extOf(name: string): string {
  const m = name.match(/\.([A-Za-z0-9]+)$/);
  return m ? m[1].toLowerCase() : "";
}

function sourceTypeForExtension(ext: string): SourceDocument["sourceType"] {
  switch (ext) {
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "bmp":
    case "tif":
    case "tiff":
    case "svg":
      return "image";
    case "json":
      return "chat";
    case "md":
    case "markdown":
    case "txt":
    case "pdf":
    case "docx":
    case "htm":
    case "html":
      return "document";
    case "csv":
    case "xlsx":
      return "spreadsheet";
    case "yaml":
    case "yml":
      return "structured";
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "py":
    case "rs":
    case "go":
    case "java":
      return "code";
    default:
      return "other";
  }
}

function nextJobId(): string {
  return `vimp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function VaultImportLocalScreen({ onBack, onStartImport }: VaultImportLocalScreenProps) {
  const [picked, setPicked] = useState<StagedSourcePreview[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePickFiles = async () => {
    setError(null);
    setPickerOpen(true);
    try {
      const selection = await open({
        multiple: true,
        directory: false,
        title: "Pick files for the Dream Vault",
      });
      if (!selection) return;
      const rawPaths = Array.isArray(selection) ? selection : [selection];
      // Normalise BEFORE staging. The Tauri dialog plugin has emitted
      // `file:///C:/...` URIs and `%20`-encoded spaces in past releases;
      // passing those straight to vault_hash_file / vault_stage_file
      // would have Rust open a literal filename like "My%20chat.json"
      // and bail with "source file not found". normalizeDialogPath
      // strips file:// prefixes + URL-decodes %-escapes; it's a no-op
      // for already-clean OS-native paths.
      const next: StagedSourcePreview[] = rawPaths.map((raw) => {
        const absolutePath = normalizeDialogPath(raw);
        const originalName = absolutePath.split(/[\\/]/).pop() ?? absolutePath;
        const ext = extOf(originalName);
        return {
          absolutePath,
          originalName,
          ...(ext ? { fileExtension: ext } : {}),
          sourceType: sourceTypeForExtension(ext),
        };
      });
      setPicked(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPickerOpen(false);
    }
  };

  const handleRemove = (path: string) => {
    setPicked((rows) => rows.filter((r) => r.absolutePath !== path));
  };

  const handleStart = () => {
    if (picked.length === 0) return;
    onStartImport(picked, nextJobId());
  };

  return (
    <div>
      <PrivacyBanner />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Import local files</h3>
        <button type="button" onClick={onBack} style={ghostBtn}>
          ← Back
        </button>
      </div>

      <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--text-secondary, #4B5563)" }}>
        Pick the PDFs, DOCX, markdown, image, or chat-export files you'd like to bring in. Files
        stay on your machine -- DreamLauncher copies them into the Dream Vault's local cache.
      </p>

      <button type="button" onClick={handlePickFiles} disabled={pickerOpen} style={primaryBtn}>
        {pickerOpen ? "Opening picker…" : "Choose files"}
      </button>

      {error && (
        <p style={{ margin: "12px 0 0", fontSize: 12, color: "#DC2626" }}>{error}</p>
      )}

      {picked.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <h4 style={{ margin: "0 0 8px", fontSize: 13 }}>
            Ready to import ({picked.length} {picked.length === 1 ? "file" : "files"})
          </h4>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", maxHeight: 260, overflowY: "auto" }}>
            {picked.map((row) => (
              <li
                key={row.absolutePath}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "8px 10px",
                  background: "var(--bg-muted, #F9FAFB)",
                  border: "1px solid var(--border-subtle, #E5E7EB)",
                  borderRadius: 8,
                  marginBottom: 6,
                  fontSize: 12,
                }}
              >
                <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <strong>{row.originalName}</strong>
                  <span style={{ color: "var(--text-tertiary, #6B7280)" }}>
                    {row.sourceType}
                    {row.fileExtension ? ` · .${row.fileExtension}` : ""}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => handleRemove(row.absolutePath)}
                  style={ghostBtn}
                  aria-label={`Remove ${row.originalName}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={handleStart}
            style={{ ...primaryBtn, marginTop: 12 }}
            disabled={picked.length === 0}
          >
            Start import →
          </button>
        </div>
      )}
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  padding: "10px 16px",
  background: "var(--accent, #4F46E5)",
  color: "var(--accent-fg, #FFFFFF)",
  border: "1px solid transparent",
  borderRadius: 10,
  fontWeight: 700,
  fontSize: 13,
  cursor: "pointer",
};

const ghostBtn: React.CSSProperties = {
  padding: "6px 12px",
  background: "transparent",
  color: "var(--text-secondary, #4B5563)",
  border: "1px solid var(--border-subtle, #E5E7EB)",
  borderRadius: 8,
  fontSize: 12,
  cursor: "pointer",
};
