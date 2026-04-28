import { generateRunId, HandoffBundle, HandoffBundleSchema, HandoffRequestType } from "@founder-os/handoff-contract";
import type { ArtifactRef } from "@founder-os/domain";

export type CreateBundleOpts = {
  ventureId: string;
  ventureRoot: string;
  type: HandoffRequestType;
  artifactRefs?: ArtifactRef[];
  payload?: Record<string, unknown>;
};

export function createBundle(opts: CreateBundleOpts): HandoffBundle {
  return HandoffBundleSchema.parse({
    runId: generateRunId(),
    ventureId: opts.ventureId,
    type: opts.type,
    createdAt: new Date().toISOString(),
    ventureRoot: opts.ventureRoot,
    artifactRefs: opts.artifactRefs ?? [],
    payload: opts.payload ?? {},
    schemaVersion: 1,
  });
}
