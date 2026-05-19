import { describe, expect, it } from "vitest";
import type {
  HashFileFn,
  ImportJobStore,
  ImportLogger,
  KnownHashLookup,
  StageOriginalFn,
} from "@founder-os/import-core";
import type { ImportJob, SourceDocument } from "@founder-os/vault-contract";
import { ingestFiles, ingestFolder, shouldIngest } from "../src/index";

function makeStore(): ImportJobStore {
  const jobs = new Map<string, ImportJob>();
  const docs: SourceDocument[] = [];
  return {
    insertJob: async (job) => {
      jobs.set(job.id, job);
    },
    updateJobStatus: async (jobId, status, errorMessage) => {
      const existing = jobs.get(jobId);
      if (!existing) return;
      jobs.set(jobId, {
        ...existing,
        status,
        errorMessage: errorMessage ?? existing.errorMessage,
      });
    },
    getJob: async (jobId) => jobs.get(jobId) ?? null,
    incrementCounts: async (jobId, delta) => {
      const existing = jobs.get(jobId);
      if (!existing) return;
      jobs.set(jobId, {
        ...existing,
        processedCount: existing.processedCount + (delta.processedCount ?? 0),
        failedCount: existing.failedCount + (delta.failedCount ?? 0),
        warningCount: existing.warningCount + (delta.warningCount ?? 0),
        fileCount: existing.fileCount + (delta.fileCount ?? 0),
      });
    },
    insertSource: async (doc) => {
      docs.push(doc);
    },
    listSourcesForJob: async (jobId) => docs.filter((d) => d.importJobId === jobId),
  };
}

function makeHashLookup(): KnownHashLookup {
  const seen = new Set<string>();
  return {
    has: async (h) => seen.has(h),
    add: async (h) => {
      seen.add(h);
    },
  };
}

const silentLogger: ImportLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const hashFile: HashFileFn = async (p) => `hash::${p}`;
const stageOriginal: StageOriginalFn = async (input) => ({
  cachedRelativePath: `_vault/_import-cache/${input.contentHash}.${input.fileExtension}`,
  byteSize: 1,
});

describe("shouldIngest", () => {
  it.each([
    ["spec.pdf", true],
    ["a.md", true],
    [".DS_Store", false],
    [".env", false],
    ["Thumbs.db", false],
    ["desktop.ini", false],
    ["", false],
  ] as const)("%s -> %s", (name, expected) => {
    expect(shouldIngest(name)).toBe(expected);
  });
});

describe("ingestFiles", () => {
  it("turns a list of paths into a needs_review job", async () => {
    const result = await ingestFiles(
      { paths: ["/in/spec.pdf", "/in/notes.md"] },
      {
        workspaceRoot: "/ws",
        resolveFile: async (p) => ({
          absolutePath: p,
          originalName: p.split("/").pop() ?? p,
        }),
        walkFolder: async () => [],
        hashFile,
        stageOriginal,
        hashLookup: makeHashLookup(),
        store: makeStore(),
        logger: silentLogger,
        nowFn: () => "2026-05-18T08:00:00.000Z",
        jobIdFactory: () => "job_test",
      },
    );
    expect(result.job.status).toBe("needs_review");
    expect(result.job.fileCount).toBe(2);
    expect(result.processed.staged).toHaveLength(2);
    expect(result.processed.staged.map((s) => s.originalName)).toEqual([
      "spec.pdf",
      "notes.md",
    ]);
  });

  it("drops junk filenames before they reach import-core", async () => {
    const result = await ingestFiles(
      { paths: ["/in/.DS_Store", "/in/spec.pdf"] },
      {
        workspaceRoot: "/ws",
        resolveFile: async (p) => ({
          absolutePath: p,
          originalName: p.split("/").pop() ?? p,
        }),
        walkFolder: async () => [],
        hashFile,
        stageOriginal,
        hashLookup: makeHashLookup(),
        store: makeStore(),
        logger: silentLogger,
        nowFn: () => "2026-05-18T08:00:00.000Z",
        jobIdFactory: () => "job_filter",
      },
    );
    expect(result.job.fileCount).toBe(1);
    expect(result.processed.staged).toHaveLength(1);
  });
});

describe("ingestFolder", () => {
  it("walks a folder + ingests the discovered files", async () => {
    const result = await ingestFolder(
      { rootPath: "/folder" },
      {
        workspaceRoot: "/ws",
        resolveFile: async (p) => ({
          absolutePath: p,
          originalName: p.split("/").pop() ?? p,
        }),
        walkFolder: async () => [
          { absolutePath: "/folder/a.pdf", originalName: "a.pdf" },
          { absolutePath: "/folder/sub/b.md", originalName: "b.md" },
          { absolutePath: "/folder/.DS_Store", originalName: ".DS_Store" },
        ],
        hashFile,
        stageOriginal,
        hashLookup: makeHashLookup(),
        store: makeStore(),
        logger: silentLogger,
        nowFn: () => "2026-05-18T08:00:00.000Z",
        jobIdFactory: () => "job_walk",
      },
    );
    expect(result.job.sourceMode).toBe("folder");
    expect(result.processed.staged.map((s) => s.originalName)).toEqual([
      "a.pdf",
      "b.md",
    ]);
  });

  it("isolates per-file failures during a folder ingest", async () => {
    const result = await ingestFolder(
      { rootPath: "/folder" },
      {
        workspaceRoot: "/ws",
        resolveFile: async (p) => ({
          absolutePath: p,
          originalName: p.split("/").pop() ?? p,
        }),
        walkFolder: async () => [
          { absolutePath: "/folder/a.pdf", originalName: "a.pdf" },
          { absolutePath: "/folder/bad.pdf", originalName: "bad.pdf" },
          { absolutePath: "/folder/c.pdf", originalName: "c.pdf" },
        ],
        hashFile: async (p) => {
          if (p === "/folder/bad.pdf") throw new Error("read failed");
          return `hash::${p}`;
        },
        stageOriginal,
        hashLookup: makeHashLookup(),
        store: makeStore(),
        logger: silentLogger,
        nowFn: () => "2026-05-18T08:00:00.000Z",
        jobIdFactory: () => "job_iso",
      },
    );
    expect(result.processed.staged).toHaveLength(2);
    expect(result.processed.failures).toHaveLength(1);
    expect(result.job.status).toBe("needs_review");
    expect(result.job.failedCount).toBe(1);
  });
});
