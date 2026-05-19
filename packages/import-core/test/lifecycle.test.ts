import { describe, expect, it } from "vitest";
import type { ImportJob } from "@founder-os/vault-contract";
import {
  IllegalImportJobTransitionError,
  advanceJob,
  assertTransition,
  canTransition,
  isTerminalStatus,
  recordFileOutcome,
} from "../src/lifecycle";

const baseJob: ImportJob = {
  id: "job_1",
  status: "queued",
  sourceProvider: "local",
  sourceMode: "files",
  fileCount: 0,
  processedCount: 0,
  failedCount: 0,
  warningCount: 0,
  createdAt: "2026-05-18T08:00:00.000Z",
  updatedAt: "2026-05-18T08:00:00.000Z",
  schemaVersion: 1,
};

describe("lifecycle transitions", () => {
  it("allows queued -> processing -> needs_review -> committed", () => {
    expect(canTransition("queued", "processing")).toBe(true);
    expect(canTransition("processing", "needs_review")).toBe(true);
    expect(canTransition("needs_review", "committed")).toBe(true);
  });

  it("forbids skipping straight to committed", () => {
    expect(canTransition("queued", "committed")).toBe(false);
    expect(canTransition("processing", "committed")).toBe(false);
  });

  it("treats terminal states as terminal", () => {
    expect(isTerminalStatus("committed")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
    expect(isTerminalStatus("queued")).toBe(false);
  });

  it("rejects re-opening a terminal job", () => {
    expect(canTransition("committed", "processing")).toBe(false);
    expect(canTransition("cancelled", "processing")).toBe(false);
  });

  it("assertTransition throws the typed error on illegal moves", () => {
    expect(() => assertTransition("queued", "committed")).toThrow(
      IllegalImportJobTransitionError,
    );
  });

  it("advanceJob returns a new object and bumps updatedAt", () => {
    const advanced = advanceJob({
      job: baseJob,
      to: "processing",
      now: "2026-05-18T09:00:00.000Z",
    });
    expect(advanced.status).toBe("processing");
    expect(advanced.updatedAt).toBe("2026-05-18T09:00:00.000Z");
    expect(baseJob.status).toBe("queued");
  });

  it("recordFileOutcome bumps the right counter", () => {
    const succeeded = recordFileOutcome({
      job: baseJob,
      outcome: "succeeded",
      now: "2026-05-18T09:00:00.000Z",
    });
    expect(succeeded.processedCount).toBe(1);
    expect(succeeded.failedCount).toBe(0);

    const failed = recordFileOutcome({
      job: baseJob,
      outcome: "failed",
      now: "2026-05-18T09:00:00.000Z",
    });
    expect(failed.failedCount).toBe(1);
    expect(failed.processedCount).toBe(1);

    const warned = recordFileOutcome({
      job: baseJob,
      outcome: "warned",
      now: "2026-05-18T09:00:00.000Z",
    });
    expect(warned.warningCount).toBe(1);
    expect(warned.processedCount).toBe(1);
  });
});
