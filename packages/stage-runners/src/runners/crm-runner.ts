/**
 * CrmStageRunner -- promoted from skeletal to real (slice 4 of CRM arc).
 *
 * Orchestrates three pipeline-runner steps under one StageRunner contract:
 *
 *   1. createCrmProvisionStep  -- resolve tier list -> CrmProvider,
 *                                  write crm-instance.json.
 *   2. createCrmSeedStep        -- read /02_validation/icp + sales-agents
 *                                  output + (opt-in) /01_research extracts,
 *                                  write seed JSON, upsert segments /
 *                                  contacts / opportunities through the
 *                                  provider.
 *   3. createCrmCampaignTemplateStep -- LLM-refine 4 brand-voiced templates
 *                                  from brand-voice.md + launch-announcement.md,
 *                                  build launch-campaign.json, upsert
 *                                  templates + create the campaign (always
 *                                  disabled -- pre-send review gate enforces).
 *
 * Behaviour
 * ---------
 *  - validate() requires manifest.id + name. Upstream artifacts are read
 *    best-effort by the steps; absence degrades gracefully.
 *  - Indexed artifacts: crm-checkpoint.json + crm-instance.json + crm-config.json,
 *    plus per-step seed JSON / template MD / launch-campaign.json.
 *  - Drift-protected log strings:
 *      "CRM stage starting",
 *      "crm: provisioned",
 *      "crm: seeded",
 *      "crm: campaign created",
 *      "crm: checkpoint written".
 *  - Pre-provision review gate: emitted when CRM is in pipeline.reviewGates
 *    OR when the resolved engine is frappe_docker (to catch port conflicts +
 *    let the user choose the bind-mount location).
 *  - Pre-send review gate: emitted always after the campaign is created.
 *    requiredApproval = "business" -- brand decision, not legal/security.
 *
 * Idempotent: each step is itself idempotent (compose project reuse,
 * provider's own upsert semantics).
 */
import type {
  ArtifactIndexEntry,
  ReviewGate,
  StageName,
  StageRunResult,
  ValidationResult,
  VentureManifest,
} from "@founder-os/domain";
import type {
  CrmCheckpoint,
  CrmEngine,
  CrmProvider,
} from "@founder-os/crm-core";
import type { Filesystem, SaasLlmCaller } from "@founder-os/pipeline-runner";
import {
  createCrmCampaignTemplateStep,
  createCrmProvisionStep,
  createCrmSeedStep,
} from "@founder-os/pipeline-runner";
import {
  getCrmCheckpointPath,
  getCrmDir,
} from "@founder-os/workspace-core";

import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

export type CrmStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  /**
   * Optional SaaS LLM caller. Subscription-mode CLIs preferred per
   * project policy (apps/founder-desktop's buildPipelineLlmCaller
   * routes through them when available). When omitted, the campaign
   * step emits deterministic-but-usable templates.
   */
  callLlm?: SaasLlmCaller;
  /**
   * Providers the runner can dispatch to. The desktop app builds this
   * map via the Tauri sidecar -- config_only is always present;
   * frappe_docker / frappe_bench are included only when their probes
   * report available=true. Empty map means provision will fail and
   * the runner reports failed.
   */
  providers?: Partial<Record<CrmEngine, CrmProvider>>;
  /**
   * Optional clock injection for tests.
   */
  now?: () => Date;
  runId?: string;
};

export class CrmStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName: StageName = "CRM";
  private readonly callLlm: SaasLlmCaller | undefined;
  private readonly providers: Partial<Record<CrmEngine, CrmProvider>>;
  private readonly now: () => Date;

  constructor(opts: CrmStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
    this.callLlm = opts.callLlm;
    this.providers = opts.providers ?? {};
    this.now = opts.now ?? (() => new Date());
  }

  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!this.manifest.id?.trim()) errors.push("manifest.id is required for CRM stage");
    if (!this.manifest.name?.trim()) errors.push("manifest.name is required for CRM stage");
    return { valid: errors.length === 0, missingResources: [], errors };
  }

  async run(): Promise<StageRunResult> {
    const requiresReview = this.stageRequiresReview();
    this.log("info", "CRM stage starting", {
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
    let engineUsed: CrmEngine | undefined;
    let segmentsUpserted = 0;
    let contactsUpserted = 0;
    let opportunitiesUpserted = 0;
    let templatesUpserted = 0;
    let campaignId: string | undefined;
    let campaignUrl: string | undefined;

    try {
      await this.fs.mkdir(getCrmDir(this.ventureRoot));

      // Step 1: provision.
      const provisionResult = await createCrmProvisionStep({
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        providers: this.providers,
        runId: this.runId,
      });
      engineUsed = provisionResult.engine;
      this.log("info", "crm: provisioned", {
        engine: engineUsed,
        siteUrl: provisionResult.instance.siteUrl,
        attempts: provisionResult.attempts,
      });
      indexEntries.push(
        this.indexEntry("crm:instance", "crm-instance", provisionResult.instancePath, startIso),
      );
      artifactPaths.push(provisionResult.instancePath);

      // Step 2: seed.
      const seedResult = await createCrmSeedStep({
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        provider: provisionResult.provider,
        runId: this.runId,
      });
      segmentsUpserted = seedResult.segmentsUpserted;
      contactsUpserted = seedResult.contactsUpserted;
      opportunitiesUpserted = seedResult.opportunitiesUpserted;
      this.log("info", "crm: seeded", {
        segments: segmentsUpserted,
        contacts: contactsUpserted,
        opportunities: opportunitiesUpserted,
        contactsBySource: seedResult.contactsBySource,
      });
      for (const path of seedResult.artifactPaths) {
        indexEntries.push(this.indexEntry(`crm:seed:${path}`, "crm-seed", path, startIso));
        artifactPaths.push(path);
      }

      // Step 3: campaign + templates.
      const campaignCtx: Parameters<typeof createCrmCampaignTemplateStep>[0] = {
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        provider: provisionResult.provider,
        runId: this.runId,
      };
      if (this.callLlm !== undefined) campaignCtx.callLlm = this.callLlm;
      const campaignResult = await createCrmCampaignTemplateStep(campaignCtx);
      templatesUpserted = campaignResult.templates.length;
      campaignId = campaignResult.campaignResult.id;
      if (campaignResult.campaignResult.url !== undefined) {
        campaignUrl = campaignResult.campaignResult.url;
      }
      this.log("info", "crm: campaign created", {
        campaignId,
        url: campaignUrl,
        templateCount: templatesUpserted,
        generationSource: campaignResult.generationSource,
      });
      for (const path of campaignResult.artifactPaths) {
        indexEntries.push(this.indexEntry(`crm:campaign:${path}`, "crm-campaign", path, startIso));
        artifactPaths.push(path);
      }

      // Write the checkpoint LAST so its counts reflect the actual run.
      const checkpoint: CrmCheckpoint = {
        runId: this.runId,
        ventureSlug: this.manifest.slug,
        startedAt: startIso,
        finishedAt: this.now().toISOString(),
        status: "completed",
        instance: provisionResult.instance,
        segmentsUpserted,
        contactsUpserted,
        opportunitiesUpserted,
        templatesUpserted,
        notes: [
          `engine: ${engineUsed}`,
          `campaign created: ${campaignId} (autoSend=false)`,
        ],
      };
      if (campaignId !== undefined) checkpoint.campaignId = campaignId;
      if (campaignUrl !== undefined) checkpoint.campaignUrl = campaignUrl;
      const checkpointPath = getCrmCheckpointPath(this.ventureRoot);
      await this.fs.writeFile(
        checkpointPath,
        `${JSON.stringify(checkpoint, null, 2)}\n`,
      );
      this.log("info", "crm: checkpoint written", { path: checkpointPath });
      indexEntries.push(this.indexEntry("crm:checkpoint", "crm-checkpoint", checkpointPath, startIso));
      artifactPaths.push(checkpointPath);

      await this.appendArtifactIndex(indexEntries);

      // Review gates: pre-send is always emitted; pre-provision is emitted
      // for the Docker tier (port + bind-mount choices) or when CRM is in
      // pipeline.reviewGates.
      const needsGate =
        requiresReview || engineUsed === "frappe_docker" || campaignId !== undefined;
      if (needsGate) {
        const gate = this.buildReviewGate(artifactPaths, engineUsed);
        await this.appendReviewGate(gate);
        reviewGateId = gate.gateId;
        this.log("info", "review gate created", {
          gateId: reviewGateId,
          reason:
            engineUsed === "frappe_docker"
              ? "docker pre-provision + pre-send"
              : "pre-send approval before campaign goes out",
        });
      }
      artifactPaths.push(...(await this.renderBrandedPdfsForStage()));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failureMessage = message;
      failureCode = "CRM_STEP_THREW";
      this.log("error", "CRM stage threw", { code: failureCode, error: message });
    } finally {
      try {
        await this.flushLogs();
      } catch (flushErr) {
        const m = flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(`stage-runners: log flush failed for CRM ${this.runId}: ${m}`);
      }
    }

    if (failureCode !== undefined) {
      return {
        success: false,
        stageName: "CRM",
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
      stageName: "CRM",
      runId: this.runId,
      artifactsCreated: artifactPaths,
      logs: [...this.logs],
      requiresReview: stageRequiresReview,
      nextStageReady: !stageRequiresReview,
    };
    if (reviewGateId !== undefined) result.reviewGateId = reviewGateId;
    return result;
  }

  private indexEntry(
    artifactId: string,
    type: string,
    path: string,
    nowIso: string,
  ): ArtifactIndexEntry {
    return {
      artifactId,
      stageName: "CRM",
      type,
      path,
      createdAt: nowIso,
      status: "ready",
      runId: this.runId,
    };
  }

  private buildReviewGate(
    artifactPaths: string[],
    engineUsed: CrmEngine | undefined,
  ): ReviewGate {
    return {
      gateId: `gate-${this.stageName}-${this.runId}`,
      stageName: this.stageName,
      runId: this.runId,
      requiredApproval: "business",
      status: "pending",
      createdAt: new Date().toISOString(),
      artifactsForReview: artifactPaths.map((p) => ({
        path: p,
        type: p.endsWith("launch-campaign.json")
          ? "crm-campaign"
          : engineUsed === "frappe_docker" && p.endsWith("crm-instance.json")
            ? "crm-instance-docker"
            : "crm-artifact",
        humanReadableContent: p,
      })),
    };
  }
}
