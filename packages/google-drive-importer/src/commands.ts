/**
 * Tauri command wrappers for Google Drive.
 *
 * Each wrapper takes an injected `invoke` function whose shape matches
 * `@tauri-apps/api/core`'s. This keeps the package decoupled from
 * Tauri (the renderer passes the real `invoke`; tests pass mocks) and
 * lets the spec's "TS side wraps each command in a typed function"
 * stay pure-TS.
 *
 * Command list (spec §3 slice 5):
 *   gdrive_start_oauth
 *   gdrive_complete_oauth
 *   gdrive_get_connection      -- our addition; UI needs current state
 *   gdrive_disconnect          -- our addition; UI's disconnect button
 *   gdrive_list_recent
 *   gdrive_search
 *   gdrive_list_folder
 *   gdrive_download_file
 *   gdrive_export_doc
 *
 * The added get_connection + disconnect commands are minimum-viable
 * surface for the slice-11 UI (connect card with status display +
 * disconnect button); both are read/clear-only against the keychain
 * reference in vault_cloud_connections.
 */
import {
  type DriveConnection,
  type DriveDownloadResult,
  type DriveExportResult,
  type DriveFile,
  type DriveOAuthComplete,
  type DriveOAuthStart,
  DriveConnectionSchema,
  DriveDownloadResultSchema,
  DriveFileSchema,
  DriveOAuthCompleteSchema,
  DriveOAuthStartSchema,
  isWorkspaceDoc,
  pickWorkspaceExport,
} from "./types.js";
import { z } from "zod";

/** Same shape as @tauri-apps/api/core's invoke. */
export type InvokeFn = <T = unknown>(
  command: string,
  args?: Record<string, unknown>
) => Promise<T>;

/** Pass when constructing the client so tests can supply a fake. */
export type DriveClientOpts = {
  invoke: InvokeFn;
};

export class DriveClient {
  constructor(private readonly opts: DriveClientOpts) {}

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * Kick off the OAuth dance. The Rust side starts a loopback HTTP
   * listener and returns the URL the system browser should open. The
   * UI is responsible for opening the consent URL (via @tauri-apps/api
   * `shell.open` or a plain `window.open`).
   */
  async startOAuth(): Promise<DriveOAuthStart> {
    const raw = await this.opts.invoke("gdrive_start_oauth");
    return DriveOAuthStartSchema.parse(raw);
  }

  /**
   * Block until the loopback listener receives the redirect with the
   * auth code, then exchange it for tokens, persist them in the
   * keychain, write the connection row in SQLite, and return the
   * connection summary.
   */
  async completeOAuth(state: string): Promise<DriveOAuthComplete> {
    const raw = await this.opts.invoke("gdrive_complete_oauth", { state });
    return DriveOAuthCompleteSchema.parse(raw);
  }

  /** Returns the current connection or null when nothing is connected. */
  async getConnection(): Promise<DriveConnection | null> {
    const raw = await this.opts.invoke<DriveConnection | null>("gdrive_get_connection");
    if (raw === null) return null;
    return DriveConnectionSchema.parse(raw);
  }

  /** Clears the keychain entry + zeroes the connection row. */
  async disconnect(connectionId: string): Promise<void> {
    await this.opts.invoke("gdrive_disconnect", { connectionId });
  }

  // -------------------------------------------------------------------------
  // Listing / search
  // -------------------------------------------------------------------------

  async listRecent(connectionId: string, pageSize = 25): Promise<DriveFile[]> {
    const raw = await this.opts.invoke<unknown>("gdrive_list_recent", {
      connectionId,
      pageSize,
    });
    return z.array(DriveFileSchema).parse(raw);
  }

  async search(connectionId: string, query: string, pageSize = 25): Promise<DriveFile[]> {
    const raw = await this.opts.invoke<unknown>("gdrive_search", {
      connectionId,
      query,
      pageSize,
    });
    return z.array(DriveFileSchema).parse(raw);
  }

  async listFolder(connectionId: string, folderId: string, pageSize = 100): Promise<DriveFile[]> {
    const raw = await this.opts.invoke<unknown>("gdrive_list_folder", {
      connectionId,
      folderId,
      pageSize,
    });
    return z.array(DriveFileSchema).parse(raw);
  }

  // -------------------------------------------------------------------------
  // Transfer
  // -------------------------------------------------------------------------

  /**
   * Download a non-Workspace file's bytes into the import cache.
   * Caller should check the file's mimeType + route Workspace docs to
   * `exportDoc` instead -- `fetchSourceBytes` below does that dispatch.
   */
  async downloadFile(opts: {
    connectionId: string;
    fileId: string;
    workspaceRoot: string;
  }): Promise<DriveDownloadResult> {
    const raw = await this.opts.invoke<unknown>("gdrive_download_file", opts);
    return DriveDownloadResultSchema.parse(raw);
  }

  /**
   * Export a Google Workspace doc to an Office-compatible format
   * (docx / xlsx / pptx) and write the bytes into the import cache.
   * Returns null when the workspace mime has no exportable target
   * (forms, sites, shortcuts).
   */
  async exportDoc(opts: {
    connectionId: string;
    fileId: string;
    mimeType: string;
    workspaceRoot: string;
  }): Promise<DriveExportResult | null> {
    const target = pickWorkspaceExport(opts.mimeType);
    if (target === null) return null;
    const raw = await this.opts.invoke<unknown>("gdrive_export_doc", {
      connectionId: opts.connectionId,
      fileId: opts.fileId,
      exportMimeType: target.exportMimeType,
      workspaceRoot: opts.workspaceRoot,
    });
    return DriveDownloadResultSchema.parse(raw);
  }

  /**
   * Convenience dispatcher: picks download or export based on the
   * file's mimeType. Returns null when Workspace export isn't
   * supported (forms / sites etc).
   */
  async fetchSourceBytes(opts: {
    connectionId: string;
    file: DriveFile;
    workspaceRoot: string;
  }): Promise<DriveDownloadResult | null> {
    if (isWorkspaceDoc(opts.file.mimeType)) {
      return this.exportDoc({
        connectionId: opts.connectionId,
        fileId: opts.file.id,
        mimeType: opts.file.mimeType,
        workspaceRoot: opts.workspaceRoot,
      });
    }
    return this.downloadFile({
      connectionId: opts.connectionId,
      fileId: opts.file.id,
      workspaceRoot: opts.workspaceRoot,
    });
  }
}

// ---------------------------------------------------------------------------
// Source-type mapping -- shared with the renderer's run-vault-import.
// ---------------------------------------------------------------------------

import type { SourceDocument } from "@founder-os/vault-contract";

/**
 * Maps a Drive file (or the result of a Workspace doc export) onto the
 * SourceDocument.sourceType enum. The renderer uses this to route
 * staged Drive files into the right extractor port.
 */
export function driveFileToSourceType(args: {
  mimeType: string;
  /** When the workspace doc has been exported, the resolved Office mime. */
  exportedMimeType?: string;
  /** When known, the original filename + extension. */
  originalName?: string;
}): SourceDocument["sourceType"] {
  const effective = args.exportedMimeType ?? args.mimeType;
  if (effective.startsWith("image/")) return "image";
  if (effective === "application/pdf") return "document";
  if (effective.includes("wordprocessingml") || effective === "application/msword") return "document";
  if (effective.includes("spreadsheetml") || effective === "text/csv") return "spreadsheet";
  if (effective.includes("presentationml")) return "document";
  if (effective === "application/json") return "chat";
  if (effective.startsWith("text/")) return "document";
  // Fall back to extension if available.
  const ext = args.originalName?.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
  if (ext === "json") return "chat";
  if (ext && ["md", "markdown", "txt", "html", "htm"].includes(ext)) return "document";
  if (ext && ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)) return "image";
  return "other";
}
