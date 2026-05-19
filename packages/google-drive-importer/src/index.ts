/**
 * @founder-os/google-drive-importer -- public entry, CLIENT-SAFE.
 *
 * Slice 5 of the DREAM_VAULT_MODULE arc. Typed wrappers around the
 * Rust-side Tauri commands that own the OAuth flow + file transfer.
 * The renderer constructs a `DriveClient` with the desktop's `invoke`
 * function; tests construct one with a mock.
 */
export {
  DriveClient,
  type DriveClientOpts,
  type InvokeFn,
  driveFileToSourceType,
} from "./commands.js";

export {
  DriveConnectionSchema,
  type DriveConnection,
  type DriveConnectionStatus,
  DriveConnectionStatusSchema,
  DriveDownloadResultSchema,
  type DriveDownloadResult,
  type DriveExportResult,
  DriveFileSchema,
  type DriveFile,
  DriveOAuthCompleteSchema,
  type DriveOAuthComplete,
  DriveOAuthStartSchema,
  type DriveOAuthStart,
  WORKSPACE_MIME_PREFIX,
  isWorkspaceDoc,
  pickWorkspaceExport,
} from "./types.js";
