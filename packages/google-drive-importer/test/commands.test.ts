/**
 * DriveClient unit tests. The wrappers are thin -- the contract being
 * tested is: argument shape passed to invoke, zod validation of the
 * Rust-side payload, and the workspace-doc dispatch.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DriveClient,
  type DriveFile,
  type InvokeFn,
  driveFileToSourceType,
  isWorkspaceDoc,
  pickWorkspaceExport,
} from "../src/index.js";

const FIXED_CONNECTION = {
  id: "conn-1",
  accountEmail: "founder@example.com",
  status: "active",
  connectedAt: "2026-05-19T00:00:00.000Z",
  lastUsedAt: null,
  tokenReference: "keyring:drive:conn-1",
};

const docxMime =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function makeInvoke(handlers: Record<string, (args: Record<string, unknown> | undefined) => unknown>) {
  const fn = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    const handler = handlers[command];
    if (!handler) throw new Error(`unexpected command: ${command}`);
    return handler(args);
  });
  return fn as unknown as InvokeFn & typeof fn;
}

describe("DriveClient.startOAuth", () => {
  it("returns the parsed start envelope", async () => {
    const invoke = makeInvoke({
      gdrive_start_oauth: () => ({
        consentUrl: "https://accounts.google.com/o/oauth2/auth?stub=1",
        state: "state-abc",
        loopbackPort: 51731,
      }),
    });
    const client = new DriveClient({ invoke });
    const out = await client.startOAuth();
    expect(out.state).toBe("state-abc");
    expect(out.loopbackPort).toBe(51731);
    expect(invoke).toHaveBeenCalledWith("gdrive_start_oauth");
  });

  it("rejects an invalid envelope shape", async () => {
    const invoke = makeInvoke({
      gdrive_start_oauth: () => ({ consentUrl: "not-a-url", state: "x", loopbackPort: 1 }),
    });
    const client = new DriveClient({ invoke });
    await expect(client.startOAuth()).rejects.toThrow();
  });
});

describe("DriveClient.completeOAuth", () => {
  it("threads state into invoke args + returns the parsed connection", async () => {
    const invoke = makeInvoke({
      gdrive_complete_oauth: (args) => {
        expect(args).toEqual({ state: "state-abc" });
        return { connection: FIXED_CONNECTION };
      },
    });
    const client = new DriveClient({ invoke });
    const { connection } = await client.completeOAuth("state-abc");
    expect(connection.accountEmail).toBe("founder@example.com");
    expect(connection.tokenReference).toBe("keyring:drive:conn-1");
  });
});

describe("DriveClient.getConnection", () => {
  it("returns null when nothing connected", async () => {
    const invoke = makeInvoke({ gdrive_get_connection: () => null });
    const client = new DriveClient({ invoke });
    expect(await client.getConnection()).toBeNull();
  });

  it("parses the connection row", async () => {
    const invoke = makeInvoke({ gdrive_get_connection: () => FIXED_CONNECTION });
    const client = new DriveClient({ invoke });
    const conn = await client.getConnection();
    expect(conn?.id).toBe("conn-1");
  });
});

describe("DriveClient.disconnect", () => {
  it("threads connectionId into invoke args", async () => {
    const invoke = makeInvoke({
      gdrive_disconnect: (args) => {
        expect(args).toEqual({ connectionId: "conn-1" });
        return null;
      },
    });
    const client = new DriveClient({ invoke });
    await client.disconnect("conn-1");
    expect(invoke).toHaveBeenCalledWith("gdrive_disconnect", { connectionId: "conn-1" });
  });
});

describe("DriveClient.listRecent / search / listFolder", () => {
  const recentRow: DriveFile = {
    id: "f-1",
    name: "Pitch deck.pdf",
    mimeType: "application/pdf",
    isFolder: false,
    isWorkspaceDoc: false,
    modifiedAt: "2026-05-18T11:00:00.000Z",
    size: 2_300_000,
  };
  it("listRecent passes pageSize default + parses each row", async () => {
    const invoke = makeInvoke({
      gdrive_list_recent: (args) => {
        expect(args).toEqual({ connectionId: "conn-1", pageSize: 25 });
        return [recentRow];
      },
    });
    const client = new DriveClient({ invoke });
    const rows = await client.listRecent("conn-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Pitch deck.pdf");
  });

  it("search threads the query string", async () => {
    const invoke = makeInvoke({
      gdrive_search: (args) => {
        expect(args).toMatchObject({ connectionId: "conn-1", query: "investor", pageSize: 25 });
        return [];
      },
    });
    const client = new DriveClient({ invoke });
    await client.search("conn-1", "investor");
  });

  it("listFolder defaults pageSize to 100", async () => {
    const invoke = makeInvoke({
      gdrive_list_folder: (args) => {
        expect(args).toMatchObject({
          connectionId: "conn-1",
          folderId: "root",
          pageSize: 100,
        });
        return [];
      },
    });
    const client = new DriveClient({ invoke });
    await client.listFolder("conn-1", "root");
  });

  it("drops rows that fail validation", async () => {
    // Validation is strict: a row missing `isFolder` should throw,
    // which surfaces malformed Rust output rather than silently dropping
    // bytes the runner can't classify.
    const invoke = makeInvoke({
      gdrive_list_recent: () => [{ id: "x", name: "x" /* missing fields */ }],
    });
    const client = new DriveClient({ invoke });
    await expect(client.listRecent("conn-1")).rejects.toThrow();
  });
});

describe("DriveClient.downloadFile / exportDoc / fetchSourceBytes", () => {
  it("downloadFile threads workspaceRoot + fileId", async () => {
    const invoke = makeInvoke({
      gdrive_download_file: (args) => {
        expect(args).toMatchObject({
          connectionId: "conn-1",
          fileId: "f-1",
          workspaceRoot: "/workspace",
        });
        return {
          cachedRelativePath: "_vault/_import-cache/aa/bb.pdf",
          absolutePath: "/workspace/_vault/_import-cache/aa/bb.pdf",
          byteSize: 2_300_000,
          contentHash: "sha256-abc",
          observedMimeType: "application/pdf",
        };
      },
    });
    const client = new DriveClient({ invoke });
    const res = await client.downloadFile({
      connectionId: "conn-1",
      fileId: "f-1",
      workspaceRoot: "/workspace",
    });
    expect(res.byteSize).toBe(2_300_000);
    expect(res.observedMimeType).toBe("application/pdf");
  });

  it("exportDoc picks docx for Google Docs", async () => {
    const invoke = makeInvoke({
      gdrive_export_doc: (args) => {
        expect(args).toMatchObject({
          connectionId: "conn-1",
          fileId: "doc-1",
          exportMimeType: docxMime,
          workspaceRoot: "/workspace",
        });
        return {
          cachedRelativePath: "_vault/_import-cache/cc/dd.docx",
          absolutePath: "/workspace/_vault/_import-cache/cc/dd.docx",
          byteSize: 50_000,
          contentHash: "sha256-xyz",
        };
      },
    });
    const client = new DriveClient({ invoke });
    const res = await client.exportDoc({
      connectionId: "conn-1",
      fileId: "doc-1",
      mimeType: "application/vnd.google-apps.document",
      workspaceRoot: "/workspace",
    });
    expect(res?.byteSize).toBe(50_000);
  });

  it("exportDoc returns null for Workspace types with no Office target", async () => {
    const invoke = makeInvoke({});
    const client = new DriveClient({ invoke });
    const res = await client.exportDoc({
      connectionId: "conn-1",
      fileId: "form-1",
      mimeType: "application/vnd.google-apps.form",
      workspaceRoot: "/workspace",
    });
    expect(res).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("fetchSourceBytes routes Workspace docs to exportDoc", async () => {
    const invoke = makeInvoke({
      gdrive_export_doc: () => ({
        cachedRelativePath: "_vault/_import-cache/cc/dd.docx",
        absolutePath: "/workspace/_vault/_import-cache/cc/dd.docx",
        byteSize: 1,
        contentHash: "h",
      }),
    });
    const client = new DriveClient({ invoke });
    await client.fetchSourceBytes({
      connectionId: "conn-1",
      file: {
        id: "doc-1",
        name: "Pitch.gdoc",
        mimeType: "application/vnd.google-apps.document",
        isFolder: false,
        isWorkspaceDoc: true,
      },
      workspaceRoot: "/workspace",
    });
    expect(invoke).toHaveBeenCalledWith(
      "gdrive_export_doc",
      expect.objectContaining({ fileId: "doc-1" })
    );
  });

  it("fetchSourceBytes routes non-Workspace files to downloadFile", async () => {
    const invoke = makeInvoke({
      gdrive_download_file: () => ({
        cachedRelativePath: "_vault/_import-cache/aa/bb.pdf",
        absolutePath: "/workspace/_vault/_import-cache/aa/bb.pdf",
        byteSize: 1,
        contentHash: "h",
      }),
    });
    const client = new DriveClient({ invoke });
    await client.fetchSourceBytes({
      connectionId: "conn-1",
      file: {
        id: "f-1",
        name: "deck.pdf",
        mimeType: "application/pdf",
        isFolder: false,
        isWorkspaceDoc: false,
      },
      workspaceRoot: "/workspace",
    });
    expect(invoke).toHaveBeenCalledWith(
      "gdrive_download_file",
      expect.objectContaining({ fileId: "f-1" })
    );
  });
});

describe("pickWorkspaceExport", () => {
  it("maps document -> docx", () => {
    const target = pickWorkspaceExport("application/vnd.google-apps.document");
    expect(target?.extension).toBe("docx");
    expect(target?.exportMimeType).toBe(docxMime);
  });

  it("maps spreadsheet -> xlsx", () => {
    expect(pickWorkspaceExport("application/vnd.google-apps.spreadsheet")?.extension).toBe("xlsx");
  });

  it("maps presentation -> pptx", () => {
    expect(pickWorkspaceExport("application/vnd.google-apps.presentation")?.extension).toBe("pptx");
  });

  it("maps drawing -> png", () => {
    expect(pickWorkspaceExport("application/vnd.google-apps.drawing")?.extension).toBe("png");
  });

  it("returns null for non-exportable Workspace types", () => {
    expect(pickWorkspaceExport("application/vnd.google-apps.form")).toBeNull();
    expect(pickWorkspaceExport("application/vnd.google-apps.shortcut")).toBeNull();
  });

  it("returns null for non-Workspace mimes", () => {
    expect(pickWorkspaceExport("application/pdf")).toBeNull();
  });
});

describe("isWorkspaceDoc", () => {
  it("recognises Workspace mimes", () => {
    expect(isWorkspaceDoc("application/vnd.google-apps.document")).toBe(true);
    expect(isWorkspaceDoc("application/pdf")).toBe(false);
  });
});

describe("driveFileToSourceType", () => {
  it("maps images by mime", () => {
    expect(driveFileToSourceType({ mimeType: "image/png" })).toBe("image");
  });
  it("maps PDF + docx exports to document", () => {
    expect(driveFileToSourceType({ mimeType: "application/pdf" })).toBe("document");
    expect(driveFileToSourceType({ mimeType: docxMime })).toBe("document");
  });
  it("maps spreadsheets", () => {
    expect(
      driveFileToSourceType({
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      })
    ).toBe("spreadsheet");
    expect(driveFileToSourceType({ mimeType: "text/csv" })).toBe("spreadsheet");
  });
  it("maps JSON to chat (the chat-importer dispatches further)", () => {
    expect(driveFileToSourceType({ mimeType: "application/json" })).toBe("chat");
  });
  it("falls back to extension when mime is generic", () => {
    expect(driveFileToSourceType({ mimeType: "application/octet-stream", originalName: "notes.md" })).toBe(
      "document"
    );
    expect(
      driveFileToSourceType({ mimeType: "application/octet-stream", originalName: "shot.jpg" })
    ).toBe("image");
  });
  it("defaults to other when nothing matches", () => {
    expect(driveFileToSourceType({ mimeType: "application/octet-stream" })).toBe("other");
  });
});
