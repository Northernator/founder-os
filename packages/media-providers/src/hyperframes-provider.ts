// HyperFrames implementation of the MediaProvider contract.
//
// Wraps the verified HyperFrames CLI surface (see MEDIA-MODULE-SPEC.md
// section 5 / 11). The pre-render gates (lint, inspect) are intentionally
// inside render() rather than in a separate validate() so a single
// provider call gives a deterministic result and a single error surface.
//
// The provider stays Node-stdlib-only -- no fs work beyond what
// ensure-project.ts already does, no third-party deps. That keeps it
// embeddable from the desktop, the cowork sidecar, or a CI job alike.

import { join } from "node:path";
import { z } from "zod";
import type {
  MediaProvider,
  MediaRenderResult,
  Shot,
} from "@founder-os/media-core";
import {
  HyperframesExitError,
  runHyperframes,
  runHyperframesJson,
} from "./spawn.js";
import {
  assertHyperframesProject,
  writeVariablesFile,
} from "./ensure-project.js";

// ---------------------------------------------------------------------------
// CLI output shapes -- narrow zod parsers so we fail loudly on schema drift.
// ---------------------------------------------------------------------------

const DoctorOutputSchema = z
  .object({ ok: z.boolean().optional() })
  .passthrough();

const LintFindingSchema = z
  .object({
    severity: z.string().optional(),
    rule: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

const LintOutputSchema = z
  .object({
    errorCount: z.number().default(0),
    warningCount: z.number().default(0),
    infoCount: z.number().default(0),
    findings: z.array(LintFindingSchema).default([]),
  })
  .passthrough();

const InspectIssueSchema = z
  .object({
    severity: z.string(),
    rule: z.string().optional(),
    message: z.string().optional(),
    selector: z.string().optional(),
    timestamp: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

const InspectOutputSchema = z
  .object({
    issues: z.array(InspectIssueSchema).default([]),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Errors specific to the gates -- callers (the stage runner) translate
// these into FailedRunBanner entries with structured findings.
// ---------------------------------------------------------------------------

export class HyperframesLintError extends Error {
  readonly findings: ReadonlyArray<z.infer<typeof LintFindingSchema>>;
  constructor(findings: ReadonlyArray<z.infer<typeof LintFindingSchema>>) {
    super(
      `hyperframes lint reported ${findings.length} finding(s): ` +
        findings
          .slice(0, 3)
          .map((f) => `[${f.severity ?? "?"}] ${f.message ?? f.rule ?? "?"}`)
          .join("; "),
    );
    this.name = "HyperframesLintError";
    this.findings = findings;
  }
}

export class HyperframesLayoutError extends Error {
  readonly issues: ReadonlyArray<z.infer<typeof InspectIssueSchema>>;
  constructor(issues: ReadonlyArray<z.infer<typeof InspectIssueSchema>>) {
    super(
      `hyperframes inspect reported ${issues.length} layout issue(s): ` +
        issues
          .slice(0, 3)
          .map((i) => `[${i.severity}] ${i.message ?? i.rule ?? "?"}`)
          .join("; "),
    );
    this.name = "HyperframesLayoutError";
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export interface CreateHyperframesProviderOpts {
  /**
   * Absolute path to the venture's HyperFrames project directory. The
   * provider reads/writes inside this dir; bootstrap it with
   * bootstrapHyperframesProject() before constructing the provider.
   */
  projectRoot: string;
  /** Override the binary name (e.g. "npx" with extra args, or absolute path). */
  binary?: string;
  /** Per-CLI-call timeout. Default 120s. */
  timeoutMs?: number;
  /** Default fps when a shot does not specify one. Default 30. */
  defaultFps?: 24 | 30 | 60;
  /** Default quality preset. Default "standard". */
  defaultQuality?: "draft" | "standard" | "high";
}

/**
 * Build a MediaProvider that drives the HyperFrames CLI for the given
 * project directory. Each shot becomes one `hyperframes render` call,
 * preceded by `lint --json` + `inspect --json --at <heros>` gates.
 */
export function createHyperframesProvider(
  opts: CreateHyperframesProviderOpts,
): MediaProvider {
  const { projectRoot } = opts;
  const binary = opts.binary;
  const timeoutMs = opts.timeoutMs;
  const defaultFps = opts.defaultFps ?? 30;
  const defaultQuality = opts.defaultQuality ?? "standard";

  const spawnOpts = {
    cwd: projectRoot,
    binary,
    timeoutMs,
  };

  return {
    name: "hyperframes",

    async available(): Promise<boolean> {
      try {
        const raw = await runHyperframesJson<unknown>(["doctor"], spawnOpts);
        const parsed = DoctorOutputSchema.safeParse(raw);
        return parsed.success && parsed.data.ok === true;
      } catch {
        return false;
      }
    },

    async render(shot: Shot, outDir: string): Promise<MediaRenderResult> {
      await assertHyperframesProject(projectRoot);

      // 1. Pre-render lint -- structural issues (missing scripts, bad attrs).
      const lintRaw = await runHyperframesJson<unknown>(["lint"], spawnOpts);
      const lint = LintOutputSchema.parse(lintRaw);
      if (lint.errorCount > 0) {
        throw new HyperframesLintError(lint.findings);
      }

      // 2. Pre-render inspect -- text-overflow / clipped containers.
      // Only run if the shot declares hero timestamps; otherwise the CLI
      // would inspect default sample points and we would be flagging
      // things outside our shot window.
      if (shot.heroTimestamps && shot.heroTimestamps.length > 0) {
        const inspectRaw = await runHyperframesJson<unknown>(
          ["inspect", "--at", shot.heroTimestamps.join(",")],
          spawnOpts,
        );
        const inspect = InspectOutputSchema.parse(inspectRaw);
        const errors = inspect.issues.filter(
          (i) => i.severity === "error",
        );
        if (errors.length > 0) {
          throw new HyperframesLayoutError(errors);
        }
      }

      // 3. Render. Variables flow via --variables-file (Windows BatBadBut
      // safe). All other args are metacharacter-free.
      const outPath = join(outDir, `shot-${shot.sceneId}.mp4`);
      const args: string[] = ["render", "--output", outPath];

      if (shot.variables && Object.keys(shot.variables).length > 0) {
        const varsPath = await writeVariablesFile(
          projectRoot,
          shot.sceneId,
          shot.variables,
        );
        args.push("--variables-file", varsPath, "--strict-variables");
      }

      args.push("--fps", String(shot.fps ?? defaultFps));
      args.push("--quality", shot.qualityPreset ?? defaultQuality);

      if (shot.deterministic) {
        args.push("--docker");
      }

      const result = await runHyperframes(args, spawnOpts);
      if (result.code !== 0) {
        throw new HyperframesExitError(args, result);
      }

      return {
        path: outPath,
        durationSec: shot.durationSec,
        engine: "hyperframes",
        meta: {
          stderr: result.stderr.slice(-2000),
        },
      };
    },
  };
}
