import { beforeEach, describe, expect, it } from "vitest";
import type {
  ImportJob,
  ImportJobStatus,
  SourceDocument,
} from "@founder-os/vault-contract";
import {
  cancelImportJob,
  commitImportJob,
  createImportJob,
  type ImportCandidate,
  type ImportJobStore,
  type ImportLogger,
  type KnownHashLookup,
  markImportJobFailed,
  processImportJob,
  type ProgressEvent,
} from "../src/index";

function createFakeStore(): ImportJobStore & { _jobs: Map<string, ImportJob>; _docs: SourceDocument[] } {
  const jobs = new Map<string, ImportJob>();
  const docs: SourceDocument[] = [];
  return {
    _jobs: jobs,
    _docs: docs,
    insertJob: async (job) => {
      jobs.set(job.id, job);
    },
    updateJobStatus: async (jobId, status, errorMessage) => {
      const existing = jobs.get(jobId);
      if (!existing) throw new Error(`unknown job ${jobId}`);
      jobs.set(jobId, { ...existing, status, errorMessage: errorMessage ?? existing.errorMessage });
    },
    getJob: async (jobId) => jobs.get(jobId) ?? null,
    incrementCounts: async (jobId, delta) => {
      const existing = jobs.get(jobId);
      if (!existing) throw new Error(`unknown job ${jobId}`);
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

function createFakeHashLookup(): KnownHashLookup & { _hashes: Set<string> } {
  const hashes = new Set<string>();
  return {
    _hashes: hashes,
    has: async (h) => hashes.has(h),
    add: async (h) => {
      hashes.add(h);
    },
  };
}

const silentLogger: ImportLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const NOW = "2026-05-18T08:00:00.000Z";

describe("createImportJob", () => {
  it("inserts a queued job", async () => {
    const store = createFakeStore();
    const job = await createImportJob({
      jobId: "job_1",
      workspaceRoot: "/ws",
      provider: "local",
      mode: "files",
      fileCount: 3,
      now: NOW,
      store,
      logger: silentLogger,
    });
    expect(job.status).toBe("queued");
    expect(job.fileCount).toBe(3);
    expect(store._jobs.get("job_1")).toBeDefined();
  });
});

describe("processImportJob", () => {
  let store: ReturnType<typeof createFakeStore>;
  let hashLookup: ReturnType<typeof createFakeHashLookup>;
  let job: ImportJob;
  let emitted: ProgressEvent[];

  beforeEach(async () => {
    store = createFakeStore();
    hashLookup = createFakeHashLookup();
    emitted = [];
    job = await createImportJob({
      jobId: "job_x",
      workspaceRoot: "/ws",
      provider: "local",
      mode: "files",
      fileCount: 0,
      now: NOW,
      store,
      logger: silentLogger,
    });
  });

  it("stages every fresh candidate and ends in needs_review", async () => {
    const candidates: ImportCandidate[] = [
      { absolutePath: "/in/spec.pdf", originalName: "spec.pdf" },
      { absolutePath: "/in/notes.md", originalName: "notes.md" },
    ];
    const result = await processImportJob({
      job,
      candidates,
      workspaceRoot: "/ws",
      hashFile: async (p) => `hash::${p}`,
      stageOriginal: async (input) => ({
        cachedRelativePath: `_vault/_import-cache/${input.contentHash}.${input.fileExtension}`,
        byteSize: 42,
      }),
      hashLookup,
      store,
      logger: silentLogger,
      emit: (e) => emitted.push(e),
      nowFn: () => NOW,
    });
    expect(result.job.status).toBe("needs_review");
    expect(result.staged).toHaveLength(2);
    expect(result.failures).toHaveLength(0);
    expect(result.duplicates).toHaveLength(0);
    expect(emitted.some((e) => e.kind === "job_status" && e.status === "needs_review")).toBe(
      true,
    );
  });

  it("isolates per-file failures so the rest of the batch still stages", async () => {
    const candidates: ImportCandidate[] = [
      { absolutePath: "/in/spec.pdf", originalName: "spec.pdf" },
      { absolutePath: "/in/bad.pdf", originalName: "bad.pdf" },
      { absolutePath: "/in/notes.md", originalName: "notes.md" },
    ];
    const result = await processImportJob({
      job,
      candidates,
      workspaceRoot: "/ws",
      hashFile: async (p) => {
        if (p === "/in/bad.pdf") throw new Error("disk read failed");
        return `hash::${p}`;
      },
      stageOriginal: async (input) => ({
        cachedRelativePath: `_vault/_import-cache/${input.contentHash}.${input.fileExtension}`,
        byteSize: 1,
      }),
      hashLookup,
      store,
      logger: silentLogger,
      nowFn: () => NOW,
    });
    expect(result.job.status).toBe("needs_review");
    expect(result.staged).toHaveLength(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.candidate.originalName).toBe("bad.pdf");
    expect(result.job.failedCount).toBe(1);
    expect(result.job.processedCount).toBe(3);
  });

  it("treats already-seen hashes as duplicates", async () => {
    await hashLookup.add("hash::/in/already.pdf");
    const candidates: ImportCandidate[] = [
      { absolutePath: "/in/already.pdf", originalName: "already.pdf" },
      { absolutePath: "/in/fresh.pdf", originalName: "fresh.pdf" },
    ];
    const result = await processImportJob({
      job,
      candidates,
      workspaceRoot: "/ws",
      hashFile: async (p) => `hash::${p}`,
      stageOriginal: async (input) => ({
        cachedRelativePath: `_vault/_import-cache/${input.contentHash}.${input.fileExtension}`,
        byteSize: 1,
      }),
      hashLookup,
      store,
      logger: silentLogger,
      nowFn: () => NOW,
    });
    expect(result.staged).toHaveLength(1);
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]?.originalName).toBe("already.pdf");
    expect(result.job.warningCount).toBe(1);
  });

  it("hashing is deterministic for the same input bytes", async () => {
    const hashFile = async (p: string) => `det::${p}`;
    const candidates: ImportCandidate[] = [
      { absolutePath: "/x", originalName: "x.txt" },
    ];
    const stageOriginalFn = async (input: { contentHash: string }) => ({
      cachedRelativePath: `_vault/_import-cache/${input.contentHash}`,
      byteSize: 1,
    });

    const storeA = createFakeStore();
    const jobA = await createImportJob({
      jobId: "job_a",
      workspaceRoot: "/ws",
      provider: "local",
      mode: "files",
      fileCount: 1,
      now: NOW,
      store: storeA,
      logger: silentLogger,
    });
    const r1 = await processImportJob({
      job: jobA,
      candidates,
      workspaceRoot: "/ws",
      hashFile,
      stageOriginal: stageOriginalFn,
      hashLookup: createFakeHashLookup(),
      store: storeA,
      logger: silentLogger,
      nowFn: () => NOW,
    });

    const storeB = createFakeStore();
    const jobB = await createImportJob({
      jobId: "job_b",
      workspaceRoot: "/ws",
      provider: "local",
      mode: "files",
      fileCount: 1,
      now: NOW,
      store: storeB,
      logger: silentLogger,
    });
    const r2 = await processImportJob({
      job: jobB,
      candidates,
      workspaceRoot: "/ws",
      hashFile,
      stageOriginal: stageOriginalFn,
      hashLookup: createFakeHashLookup(),
      store: storeB,
      logger: silentLogger,
      nowFn: () => NOW,
    });
    expect(r1.staged[0]?.contentHash).toBe(r2.staged[0]?.contentHash);
  });
});

describe("commitImportJob + cancelImportJob + markImportJobFailed", () => {
  it("commitImportJob requires needs_review", async () => {
    const store = createFakeStore();
    const job = await createImportJob({
      jobId: "j1",
      workspaceRoot: "/ws",
      provider: "local",
      mode: "files",
      fileCount: 0,
      now: NOW,
      store,
      logger: silentLogger,
    });
    await expect(
      commitImportJob({ job, store, logger: silentLogger, now: NOW }),
    ).rejects.toThrow(/Illegal/);
  });

  it("commitImportJob moves needs_review -> committed", async () => {
    const store = createFakeStore();
    const job: ImportJob = {
      id: "j",
      status: "needs_review",
      sourceProvider: "local",
      sourceMode: "files",
      fileCount: 0,
      processedCount: 0,
      failedCount: 0,
      warningCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
      schemaVersion: 1,
    };
    store._jobs.set(job.id, job);
    const result = await commitImportJob({ job, store, logger: silentLogger, now: NOW });
    expect(result.status).toBe("committed");
  });

  it("cancelImportJob is allowed from queued/processing/needs_review", async () => {
    const store = createFakeStore();
    for (const status of ["queued", "processing", "needs_review"] as ImportJobStatus[]) {
      const job: ImportJob = {
        id: `j_${status}`,
        status,
        sourceProvider: "local",
        sourceMode: "files",
        fileCount: 0,
        processedCount: 0,
        failedCount: 0,
        warningCount: 0,
        createdAt: NOW,
        updatedAt: NOW,
        schemaVersion: 1,
      };
      store._jobs.set(job.id, job);
      const result = await cancelImportJob({
        job,
        store,
        logger: silentLogger,
        now: NOW,
        reason: "user clicked cancel",
      });
      expect(result.status).toBe("cancelled");
      expect(result.errorMessage).toBe("user clicked cancel");
    }
  });

  it("markImportJobFailed terminates the job", async () => {
    const store = createFakeStore();
    const job: ImportJob = {
      id: "j_fail",
      status: "processing",
      sourceProvider: "local",
      sourceMode: "files",
      fileCount: 0,
      processedCount: 0,
      failedCount: 0,
      warningCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
      schemaVersion: 1,
    };
    store._jobs.set(job.id, job);
    const result = await markImportJobFailed({
      job,
      store,
      logger: silentLogger,
      now: NOW,
      reason: "store dead",
    });
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("store dead");
  });
});
