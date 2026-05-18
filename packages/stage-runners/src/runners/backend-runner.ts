/**
 * BackendStageRunner -- promoted from skeletal to real (slice 4 of backend arc).
 *
 * Orchestrates four pipeline-runner steps under one StageRunner contract:
 *
 *   1. createBackendProvisionStep -- walk the engine tier list -> pick a
 *                                    BackendProvider, write
 *                                    backend-instance.json + backend-config.json
 *   2. createBackendSchemaStep    -- read spec-canvas.json entities ->
 *                                    Collection[], call provider.applySchema()
 *   3. createBackendHooksStep     -- read must-feature ACs -> pb_hooks/*.pb.js
 *                                    stubs. LLM-refined when callLlm passed.
 *   4. createBackendExportStep    -- provider.export() -> backend-export.json
 *                                    + 12_backend/sdk/{client,types,hooks}.ts
 *
 * Behaviour
 * ---------
 *  - validate() requires manifest.id + name. Upstream spec-canvas + brand
 *    artifacts are best-effort -- absence degrades gracefully (the schema
 *    step emits an empty-collection-list note; the hooks step emits an
 *    empty stub file).
 *  - Indexed artifacts: backend-checkpoint.json + backend-instance.json +
 *    backend-config.json + derived-collections.json + backend-export.json
 *    + the 3 hook files + the 3 SDK files.
 *  - Drift-protected log strings (asserted in log-strings.test.ts):
 *      "BACKEND stage starting",
 *      "backend: provisioned",
 *      "backend: schema applied",
 *      "backend: hooks generated",
 *      "backend: export written",
 *      "backend: checkpoint written".
 *  - Schema review gate: emitted always after the schema step (spec sec
 *    10 is explicit -- changing API rules later requires touching every
 *    consumer, so we front-load the review). requiredApproval =
 *    "security" because rule mistakes have security consequences.
 *
 * Back-compat with the skeletal slice: when `providers` map is empty,
 * the runner short-circuits with the same 3 "skipped" markers + the
 * skeletal checkpoint shape, so callers that haven't migrated to slice 4
 * yet still see the runner succeed. Once the desktop's slice 5a wiring
 * is in place the providers map will always be populated.
 *
 * Idempotent: each step is itself idempotent (provider's own
 * applySchema/export, deterministic hook regeneration).
 */
import {
  type BackendCheckpoint,
  type BackendEngine,
  type BackendProvider,
} from "@founder-os/backend-core";
import type {
  ArtifactIndexEntry,
  ReviewGate,
  StageName,
  StageRunResult,
  ValidationResult,
  VentureManifest,
} from "@founder-os/domain";
import type { Filesystem, SaasLlmCaller } from "@founder-os/pipeline-runner";
import {
  createBackendExportStep,
  createBackendHooksStep,
  createBackendProvisionStep,
  createBackendSchemaStep,
} from "@founder-os/pipeline-runner";
import {
  getBackendCheckpointPath,
  getBackendDir,
} from "@founder-os/workspace-core";

import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

export type BackendStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  /**
   * Optional SaaS LLM caller. Subscription-mode CLIs preferred per
   * project policy (apps/founder-desktop's buildPipelineLlmCaller
   * routes through them when available). When omitted, the hooks step
   * emits deterministic-but-usable stubs from raw AC text.
   */
  callLlm?: SaasLlmCaller;
  /**
   * Providers the runner can dispatch to. The desktop app builds this
   * map via the Tauri sidecar -- config_only is always present;
   * pocketbase is included when its probe reports available=true. Empty
   * map keeps the runner in skeletal mode for back-compat with callers
   * that haven't migrated to slice 4 yet.
   */
  providers?: Partial<Record<BackendEngine, BackendProvider>>;
  /**
   * Optional clock injection for tests.
   */
  now?: () => Date;
  runId?: string;
};

export class BackendStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName: StageName = "BACKEND";
  private readonly callLlm: SaasLlmCaller | undefined;
  private readonly providers: Partial<Record<BackendEngine, BackendProvider>>;
  private readonly now: () => Date;

  constructor(opts: BackendStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
    this.callLlm = opts.callLlm;
    this.providers = opts.providers ?? {};
    this.now = opts.now ?? (() => new Date());
  }

  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!this.manifest.id?.trim()) errors.push("manifest.id is required for backend stage");
    if (!this.manifest.name?.trim()) errors.push("manifest.name is required for backend stage");
    return { valid: errors.length === 0, missingResources: [], errors };
  }

  async run(): Promise<StageRunResult> {
    const hasProviders = Object.keys(this.providers).length > 0;
    if (!hasProviders) {
      return this.runSkeletal();
    }
    return this.runReal();
  }

  // -------------------------------------------------------------------------
  // Real path (slice 4 promotion)
  // -------------------------------------------------------------------------

  private async runReal(): Promise<StageRunResult> {
    const requiresReview = this.stageRequiresReview();
    this.log("info", "BACKEND stage starting", {
      runId: this.runId,
      requiresReview,
      withLlm: this.callLlm !== undefined,
      providerCount: Object.keys(this.providers).length,
    });

    const indexEntries: ArtifactIndexEntry[] = [];
    const artifactPaths: string[] = [];
    const startIso = this.now().toISOString();
    let reviewGateId: string | undefined;
    let failureCode: string | undefined;
    let failureMessage: string | undefined;
    let engineUsed: BackendEngine | undefined;
    let collectionsApplied = 0;
    let hooksGenerated = 0;
    let exportPath: string | undefined;

    try {
      await this.fs.mkdir(getBackendDir(this.ventureRoot));

      // Step 1: provision.
      const provisionResult = await createBackendProvisionStep({
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        providers: this.providers,
        runId: this.runId,
      });
      engineUsed = provisionResult.engine;
      this.log("info", "backend: provisioned", {
        engine: engineUsed,
        baseUrl: provisionResult.instance.baseUrl,
        attempts: provisionResult.attempts,
      });
      indexEntries.push(
        this.indexEntry("backend:instance", "backend-instance", provisionResult.instancePath, startIso),
      );
      indexEntries.push(
        this.indexEntry("backend:config", "backend-config", provisionResult.configPath, startIso),
      );
      artifactPaths.push(provisionResult.instancePath, provisionResult.configPath);

      // Step 2: schema.
      const baseUrl = provisionResult.instance.baseUrl ?? "";
      const schemaResult = await createBackendSchemaStep({
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        provider: provisionResult.provider,
        baseUrl,
        runId: this.runId,
      });
      collectionsApplied = schemaResult.collectionsApplied;
      this.log("info", "backend: schema applied", {
        collectionsApplied,
        notes: schemaResult.notes,
      });
      indexEntries.push(
        this.indexEntry(
          "backend:derived-collections",
          "backend-derived-collections",
          schemaResult.derivedCollectionsPath,
          startIso,
        ),
      );
      artifactPaths.push(schemaResult.derivedCollectionsPath);

      // Step 3: hooks.
      const hooksCtx: Parameters<typeof createBackendHooksStep>[0] = {
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        provider: provisionResult.provider,
        runId: this.runId,
      };
      if (this.callLlm !== undefined) hooksCtx.callLlm = this.callLlm;
      const hooksResult = await createBackendHooksStep(hooksCtx);
      hooksGenerated = hooksResult.hooksGenerated;
      this.log("info", "backend: hooks generated", {
        hooksGenerated,
        generationSource: hooksResult.generationSource,
        notes: hooksResult.notes,
      });
      for (const path of [
        hooksResult.loggingHookPath,
        hooksResult.businessRulesHookPath,
        hooksResult.devSeedHookPath,
      ]) {
        indexEntries.push(this.indexEntry(`backend:hook:${path}`, "backend-hook", path, startIso));
        artifactPaths.push(path);
      }

      // Step 4: export + SDK.
      const exportResult = await createBackendExportStep({
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        provider: provisionResult.provider,
        instance: provisionResult.instance,
        collections: schemaResult.collections,
        runId: this.runId,
      });
      exportPath = exportResult.exportPath;
      this.log("info", "backend: export written", {
        exportPath,
        collectionCount: exportResult.collectionCount,
        hasLiveCollections: exportResult.hasLiveCollections,
      });
      indexEntries.push(
        this.indexEntry("backend:export", "backend-export", exportResult.exportPath, startIso),
      );
      indexEntries.push(
        this.indexEntry("backend:sdk:client", "backend-sdk", exportResult.sdkPaths.client, startIso),
      );
      indexEntries.push(
        this.indexEntry("backend:sdk:types", "backend-sdk", exportResult.sdkPaths.types, startIso),
      );
      indexEntries.push(
        this.indexEntry("backend:sdk:hooks", "backend-sdk", exportResult.sdkPaths.hooks, startIso),
      );
      artifactPaths.push(
        exportResult.exportPath,
        exportResult.sdkPaths.client,
        exportResult.sdkPaths.types,
        exportResult.sdkPaths.hooks,
      );

      // Write the checkpoint LAST so its counts reflect the actual run.
      const checkpoint: BackendCheckpoint = {
        runId: this.runId,
        ventureSlug: this.manifest.slug,
        startedAt: startIso,
        finishedAt: this.now().toISOString(),
        status: "completed",
        instance: provisionResult.instance,
        collectionsApplied,
        hooksGenerated,
        exportPath,
        notes: [
          `engine: ${engineUsed}`,
          `collections applied: ${collectionsApplied}`,
          `hooks generated: ${hooksGenerated} (source: ${hooksResult.generationSource})`,
          ...schemaResult.notes,
          ...hooksResult.notes,
          ...exportResult.notes,
        ],
      };
      const checkpointPath = getBackendCheckpointPath(this.ventureRoot);
      await this.fs.writeFile(
        checkpointPath,
        `${JSON.stringify(checkpoint, null, 2)}\n`,
      );
      this.log("info", "backend: checkpoint written", { path: checkpointPath });
      indexEntries.push(
        this.indexEntry("backend:checkpoint", "backend-checkpoint", checkpointPath, startIso),
      );
      artifactPaths.push(checkpointPath);

      await this.appendArtifactIndex(indexEntries);

      // Schema review gate: emitted always when the real path ran. Spec
      // sec 10 makes this non-negotiable -- API rules drift after BUILD
      // wires the frontend is too painful to leave to a manual review
      // toggle. requiredApproval = "security" because rule mistakes
      // have security consequences.
      const needsGate =
        requiresReview ||
        engineUsed !== "config_only" ||
        collectionsApplied > 0;
      if (needsGate) {
        const gate = this.buildSchemaReviewGate(artifactPaths, engineUsed);
        await this.appendReviewGate(gate);
        reviewGateId = gate.gateId;
        this.log("info", "review gate created", {
          gateId: reviewGateId,
          reason: "schema + API rules require approval before BUILD reads the export",
        });
      }
      artifactPaths.push(...(await this.renderBrandedPdfsForStage()));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failureMessage = message;
      failureCode = "BACKEND_STEP_THREW";
      this.log("error", "BACKEND stage threw", { code: failureCode, error: message });
    } finally {
      try {
        await this.flushLogs();
      } catch (flushErr) {
        const m = flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(`stage-runners: log flush failed for BACKEND ${this.runId}: ${m}`);
      }
    }

    if (failureCode !== undefined) {
      return {
        success: false,
        stageName: "BACKEND",
        runId: this.runId,
        artifactsCreated: artifactPaths,
        logs: [...this.logs],
        requiresReview: false,
        nextStageReady: false,
        error: { code: failureCode, message: failureMessage ?? "unknown", recoverable: true },
      };
    }

    const stageRequiresReview = reviewGateId !== undefined;
    const result: StageRunResult = {
      success: true,
      stageName: "BACKEND",
      runId: this.runId,
      artifactsCreated: artifactPaths,
      logs: [...this.logs],
      requiresReview: stageRequiresReview,
      nextStageReady: !stageRequiresReview,
    };
    if (reviewGateId !== undefined) result.reviewGateId = reviewGateId;
    return result;
  }

  // -------------------------------------------------------------------------
  // Skeletal path (kept for back-compat with callers that haven't passed
  // a providers map yet). Same log strings as before slice 4 so any
  // pre-promotion code paths keep working.
  // -------------------------------------------------------------------------

  private async runSkeletal(): Promise<StageRunResult> {
    const requiresReview = this.stageRequiresReview();
    this.log("info", "BACKEND stage starting", {
      runId: this.runId,
      requiresReview,
      skeletal: true,
    });

    const indexEntries: ArtifactIndexEntry[] = [];
    const artifactPaths: string[] = [];
    const nowIso = this.now().toISOString();
    let failureCode: string | undefined;
    let failureMessage: string | undefined;

    try {
      this.log("info", "backend-provision skipped", {
        reason: "skeletal -- providers map empty",
      });
      this.log("info", "backend-schema skipped", {
        reason: "skeletal -- providers map empty",
      });
      this.log("info", "backend-hooks skipped", {
        reason: "skeletal -- providers map empty",
      });

      const checkpointPath = getBackendCheckpointPath(this.ventureRoot);
      const checkpoint = {
        runId: this.runId,
        ventureSlug: this.manifest.slug,
        startedAt: nowIso,
        finishedAt: nowIso,
        status: "completed",
        collectionsApplied: 0,
        hooksGenerated: 0,
        notes: [
          "BackendStageRunner ran with empty providers map (back-compat skeletal path).",
          "Pass providers via BackendStageRunnerOpts to run the real slice 4 pipeline.",
        ],
      };
      await this.fs.writeFile(
        checkpointPath,
        `${JSON.stringify(checkpoint, null, 2)}\n`,
      );
      this.log("info", "backend checkpoint written", { path: checkpointPath });

      indexEntries.push({
        artifactId: "backend:checkpoint",
        stageName: "BACKEND",
        type: "backend-checkpoint",
        path: checkpointPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      artifactPaths.push(checkpointPath);

      await this.appendArtifactIndex(indexEntries);
      artifactPaths.push(...(await this.renderBrandedPdfsForStage()));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failureMessage = message;
      failureCode = "BACKEND_STEP_THREW";
      this.log("error", "BACKEND stage threw", { code: failureCode, error: message });
    } finally {
      try {
        await this.flushLogs();
      } catch (flushErr) {
        const m = flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(`stage-runners: log flush failed for BACKEND ${this.runId}: ${m}`);
      }
    }

    if (failureCode !== undefined) {
      return {
        success: false,
        stageName: "BACKEND",
        runId: this.runId,
        artifactsCreated: artifactPaths,
        logs: [...this.logs],
        requiresReview: false,
        nextStageReady: false,
        error: { code: failureCode, message: failureMessage ?? "unknown", recoverable: true },
      };
    }

    return {
      success: true,
      stageName: "BACKEND",
      runId: this.runId,
      artifactsCreated: artifactPaths,
      logs: [...this.logs],
      requiresReview,
      nextStageReady: !requiresReview,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private indexEntry(
    artifactId: string,
    type: string,
    path: string,
    nowIso: string,
  ): ArtifactIndexEntry {
    return {
      artifactId,
      stageName: "BACKEND",
      type,
      path,
      createdAt: nowIso,
      status: "ready",
      runId: this.runId,
    };
  }

  private buildSchemaReviewGate(
    artifactPaths: string[],
    engineUsed: BackendEngine | undefined,
  ): ReviewGate {
    return {
      gateId: `gate-${this.stageName}-${this.runId}`,
      stageName: this.stageName,
      runId: this.runId,
      requiredApproval: "security",
      status: "pending",
      createdAt: new Date().toISOString(),
      artifactsForReview: artifactPaths.map((p) => ({
        path: p,
        type: p.endsWith("derived-collections.json")
          ? "backend-derived-collections"
          : p.endsWith("backend-export.json")
            ? "backend-export"
            : engineUsed === "pocketbase" && p.endsWith("backend-instance.json")
              ? "backend-instance-pocketbase"
              : "backend-artifact",
        humanReadableContent: p,
      })),
    };
  }
}
