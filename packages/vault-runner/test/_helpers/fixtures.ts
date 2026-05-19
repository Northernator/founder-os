import type { ImportJob, SourceDocument } from "@founder-os/vault-contract";
import type { ImportJobStore, ImportLogger } from "@founder-os/import-core";
import { createMemoryFsPort } from "@founder-os/markdown-vault";

export const NOW = "2026-05-19T00:00:00.000Z";

export function makeJob(over: Partial<ImportJob> = {}): ImportJob {
  return {
    id: "job-1",
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
    ...over,
  };
}

export function makeSource(over: Partial<SourceDocument> = {}): SourceDocument {
  return {
    id: "src-1",
    importJobId: "job-1",
    sourceType: "document",
    sourceProvider: "local",
    originalName: "kickoff-notes.md",
    mimeType: "text/markdown",
    fileExtension: "md",
    cachedOriginalPath: "_vault/_import-cache/aa/notes.md",
    contentHash: "aa" + "1".repeat(62),
    byteSize: 100,
    extractionStatus: "pending",
    confidence: "medium",
    needsReview: false,
    createdAt: NOW,
    schemaVersion: 1,
    ...over,
  };
}

export function makeLogger(): ImportLogger & { events: Array<{ level: string; event: string; data?: unknown }> } {
  const events: Array<{ level: string; event: string; data?: unknown }> = [];
  return {
    events,
    info: (event, data) => events.push({ level: "info", event, data }),
    warn: (event, data) => events.push({ level: "warn", event, data }),
    error: (event, data) => events.push({ level: "error", event, data }),
  };
}

/** ImportJobStore double that records the last status the runner set. */
export function makeStore(initialJob: ImportJob): ImportJobStore & {
  jobs: Map<string, ImportJob>;
  sourceCount: number;
  lastStatus: () => ImportJob["status"];
} {
  const jobs = new Map<string, ImportJob>([[initialJob.id, { ...initialJob }]]);
  let sourceCount = 0;
  return {
    jobs,
    get sourceCount() {
      return sourceCount;
    },
    lastStatus: () => jobs.get(initialJob.id)?.status ?? initialJob.status,
    insertJob: async (job) => {
      jobs.set(job.id, { ...job });
    },
    updateJobStatus: async (jobId, status, errorMessage) => {
      const existing = jobs.get(jobId);
      if (!existing) return;
      const next: ImportJob = { ...existing, status };
      if (errorMessage !== undefined) next.errorMessage = errorMessage;
      jobs.set(jobId, next);
    },
    getJob: async (jobId) => jobs.get(jobId) ?? null,
    incrementCounts: async () => {
      /* tests don't rely on counts; noop */
    },
    insertSource: async () => {
      sourceCount += 1;
    },
    listSourcesForJob: async () => [],
  };
}

export function memoryVaultFs() {
  return createMemoryFsPort();
}

export function makeResolveCachedPath(workspaceRoot: string) {
  return (workspaceRelativePath: string): string =>
    `${workspaceRoot.replace(/\/+$/, "")}/${workspaceRelativePath.replace(/^\/+/, "")}`;
}
