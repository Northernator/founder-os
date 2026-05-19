/**
 * @founder-os/google-drive-importer -- types.
 *
 * Slice 5 of the DREAM_VAULT_MODULE arc. CLIENT-SAFE -- no node:*
 * imports. The OAuth flow + actual file transfer happen Rust-side
 * through Tauri commands; this package is the typed TS surface the
 * renderer calls. The Rust side keeps OAuth tokens in the OS
 * keychain via the `keyring` crate and only stores an opaque
 * `token_reference` in the SQLite `vault_cloud_connections` row.
 *
 * Per the spec §1.6 / §6: Drive scopes are read-only
 * (drive.readonly + drive.metadata.readonly); files are never
 * modified.
 */
import { z } from "zod";

/** Connection lifecycle. Maps onto vault_cloud_connections.status. */
export const DriveConnectionStatusSchema = z.enum([
  "disconnected",
  "connecting",
  "active",
  "expired",
  "error",
]);
export type DriveConnectionStatus = z.infer<typeof DriveConnectionStatusSchema>;

/** Current connection summary the UI binds to. */
export const DriveConnectionSchema = z.object({
  id: z.string(),
  accountEmail: z.string(),
  status: DriveConnectionStatusSchema,
  /** ISO timestamp. */
  connectedAt: z.string(),
  /** ISO timestamp; null when never used after connect. */
  lastUsedAt: z.string().nullable(),
  /** Opaque keychain reference -- never the token itself. */
  tokenReference: z.string(),
});
export type DriveConnection = z.infer<typeof DriveConnectionSchema>;

/**
 * Sub-shape returned by `gdrive_list_recent`, `gdrive_search`,
 * `gdrive_list_folder`. We project the Drive API v3 file shape down
 * to the fields the UI actually renders + the runner needs to route
 * the download.
 */
export const DriveFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  /** True when this is a folder, false otherwise. Computed Rust-side. */
  isFolder: z.boolean(),
  /** Drive's "modifiedTime" in ISO. */
  modifiedAt: z.string().optional(),
  /** Bytes; absent for Workspace docs (they have no fixed size). */
  size: z.number().int().nonnegative().optional(),
  /** Web-view URL for "Open in Drive" affordances. */
  webViewLink: z.string().url().optional(),
  /** True when this is a Google Workspace doc and should be exported via gdrive_export_doc. */
  isWorkspaceDoc: z.boolean(),
  /** Owner email when discoverable -- helps the user disambiguate shared files. */
  ownerEmail: z.string().optional(),
});
export type DriveFile = z.infer<typeof DriveFileSchema>;

/** OAuth-start envelope. The Rust command opens this URL in the system browser. */
export const DriveOAuthStartSchema = z.object({
  /** Consent screen URL the user is sent to. */
  consentUrl: z.string().url(),
  /** Opaque token the renderer threads back to `completeOAuth`. */
  state: z.string(),
  /** Loopback port the Rust side is listening on. */
  loopbackPort: z.number().int().positive(),
});
export type DriveOAuthStart = z.infer<typeof DriveOAuthStartSchema>;

/** Settles to the active connection once consent is granted. */
export const DriveOAuthCompleteSchema = z.object({
  connection: DriveConnectionSchema,
});
export type DriveOAuthComplete = z.infer<typeof DriveOAuthCompleteSchema>;

/** Result of writing a Drive file's bytes into the workspace import cache. */
export const DriveDownloadResultSchema = z.object({
  /** Workspace-relative path Rust wrote the bytes to (under _vault/_import-cache/). */
  cachedRelativePath: z.string(),
  /** Absolute path the renderer can hand to vault_read_file_bytes. */
  absolutePath: z.string(),
  /** Bytes written. */
  byteSize: z.number().int().nonnegative(),
  /** SHA-256 content hash of the bytes Rust wrote. */
  contentHash: z.string(),
  /** Mime type Rust observed during the download -- may differ from the metadata mime. */
  observedMimeType: z.string().optional(),
});
export type DriveDownloadResult = z.infer<typeof DriveDownloadResultSchema>;

/** Workspace-doc export envelope mirrors DriveDownloadResult. */
export type DriveExportResult = DriveDownloadResult;

// ---------------------------------------------------------------------------
// Workspace mime helpers
// ---------------------------------------------------------------------------

/** Mime prefix Google uses for Workspace docs. */
export const WORKSPACE_MIME_PREFIX = "application/vnd.google-apps.";

/**
 * Returns the export mime + file extension Drive should use when
 * converting a Workspace doc. Per spec slice 5: "Workspace docs export
 * to docx; non-Workspace files download as-is."
 *
 * We pick the closest Office-compatible export per type:
 *   document        -> docx
 *   spreadsheet     -> xlsx
 *   presentation    -> pptx
 *   drawing         -> png
 *   form / site     -> not exportable; caller should skip.
 *
 * Returns null when the mimetype is not a Workspace doc.
 */
export function pickWorkspaceExport(
  mimeType: string
): { exportMimeType: string; extension: string } | null {
  if (!mimeType.startsWith(WORKSPACE_MIME_PREFIX)) return null;
  const kind = mimeType.slice(WORKSPACE_MIME_PREFIX.length);
  switch (kind) {
    case "document":
      return { exportMimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: "docx" };
    case "spreadsheet":
      return { exportMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: "xlsx" };
    case "presentation":
      return { exportMimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", extension: "pptx" };
    case "drawing":
      return { exportMimeType: "image/png", extension: "png" };
    default:
      // form / site / shortcut / fusiontable -- not exportable.
      return null;
  }
}

/** True when the file is a Google Workspace doc that needs export rather than download. */
export function isWorkspaceDoc(mimeType: string): boolean {
  return mimeType.startsWith(WORKSPACE_MIME_PREFIX);
}
