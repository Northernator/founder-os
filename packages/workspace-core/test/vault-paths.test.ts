import { describe, expect, it } from "vitest";
import {
  VAULT_PROJECT_DIRS,
  getImportCacheDir,
  getImportCacheFilePath,
  getVaultInboxPath,
  getVaultJobDir,
  getVaultJobLogPath,
  getVaultJobsRoot,
  getVaultProjectRoot,
  getVaultProjectSubdir,
  getVaultProjectsRoot,
  getVaultRoot,
  getVaultUnsortedDir,
  vaultDirSkeleton,
} from "../src/paths";

const WS = "/tmp/workspace";

describe("vault path helpers", () => {
  it("getVaultRoot is workspaceRoot/_vault", () => {
    expect(getVaultRoot(WS)).toBe("tmp/workspace/_vault");
  });

  it("import cache + jobs + inbox + unsorted live under the vault root", () => {
    expect(getImportCacheDir(WS)).toBe("tmp/workspace/_vault/_import-cache");
    expect(getVaultJobsRoot(WS)).toBe("tmp/workspace/_vault/_jobs");
    expect(getVaultInboxPath(WS)).toBe("tmp/workspace/_vault/inbox");
    expect(getVaultUnsortedDir(WS)).toBe("tmp/workspace/_vault/unsorted");
  });

  it("project subtree is keyed by venture slug", () => {
    expect(getVaultProjectsRoot(WS)).toBe("tmp/workspace/_vault/projects");
    expect(getVaultProjectRoot(WS, "acme")).toBe("tmp/workspace/_vault/projects/acme");
  });

  it("project subdir resolves to the numbered convention", () => {
    expect(getVaultProjectSubdir(WS, "acme", "index")).toBe(
      "tmp/workspace/_vault/projects/acme/00_index",
    );
    expect(getVaultProjectSubdir(WS, "acme", "chatSummaries")).toBe(
      "tmp/workspace/_vault/projects/acme/10_chat-summaries",
    );
    expect(getVaultProjectSubdir(WS, "acme", "rawArchive")).toBe(
      "tmp/workspace/_vault/projects/acme/90_raw-archive",
    );
  });

  it("VAULT_PROJECT_DIRS contains all 10 documented numbered slots", () => {
    expect(Object.keys(VAULT_PROJECT_DIRS)).toHaveLength(10);
  });

  it("job dir + log path are nested correctly", () => {
    expect(getVaultJobDir(WS, "job_42")).toBe("tmp/workspace/_vault/_jobs/job_42");
    expect(getVaultJobLogPath(WS, "job_42")).toBe(
      "tmp/workspace/_vault/_jobs/job_42/log.jsonl",
    );
  });

  it("import-cache file path shards by the first two hex chars", () => {
    const path = getImportCacheFilePath(WS, "ab12cdef34567890", "pdf");
    expect(path).toBe("tmp/workspace/_vault/_import-cache/ab/12cdef34567890.pdf");
  });

  it("import-cache file path drops a leading dot in the extension", () => {
    expect(getImportCacheFilePath(WS, "abcd1234", ".PDF")).toContain("/cd1234.PDF");
  });

  it("import-cache file path omits the dot when extension is empty", () => {
    expect(getImportCacheFilePath(WS, "abcd1234", "")).toBe(
      "tmp/workspace/_vault/_import-cache/ab/cd1234",
    );
  });

  it("import-cache file path rejects too-short hashes", () => {
    expect(() => getImportCacheFilePath(WS, "ab", "pdf")).toThrow();
  });

  it("vaultDirSkeleton lists every top-level vault directory", () => {
    const dirs = vaultDirSkeleton(WS);
    expect(dirs).toContain("tmp/workspace/_vault");
    expect(dirs).toContain("tmp/workspace/_vault/_import-cache");
    expect(dirs).toContain("tmp/workspace/_vault/_jobs");
    expect(dirs).toContain("tmp/workspace/_vault/inbox");
    expect(dirs).toContain("tmp/workspace/_vault/unsorted");
    expect(dirs).toContain("tmp/workspace/_vault/projects");
  });
});
