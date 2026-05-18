import { AuditSummarySchema } from "@founder-os/audit-contract";
import { ArtifactRefSchema } from "@founder-os/domain";
import { z } from "zod";

export const HandoffRequestTypeSchema = z.enum([
  // Provider-agnostic build handoff (slice 7 of dual-handoff arc).
  // Bundle payload includes the parsed HandoffExport so VS Code sees
  // adjustable knobs (parameters) when CoDesign produced the export,
  // and the prompt when Stitch did. Prefer this over BUILD_FROM_STITCH_EXPORT
  // for any new bundle.
  "BUILD_FROM_HANDOFF_EXPORT",
  // Backend handoff (slice 6 of backend arc). Bundle payload includes
  // the parsed BackendExport so VS Code sees the resolved engine,
  // baseUrl, collections, auth providers, and SDK import path. Emitted
  // ALONGSIDE BUILD_FROM_HANDOFF_EXPORT (frontend and backend bundles
  // are independent) -- the extension can consume either or both.
  "BUILD_FROM_BACKEND_EXPORT",
  // Pre-slice-7 alias. Kept so old bundles in handoffs/inbox/ still
  // parse and so the cowork system-prompts registry (apps/founder-cowork)
  // doesn't break. New bundles should use BUILD_FROM_HANDOFF_EXPORT.
  "BUILD_FROM_STITCH_EXPORT",
  "BUILD_FROM_BRIEF",
  "GENERATE_CODE_WIKI",
  "GENERATE_TRUTH_LAYER",
  "RUN_AUDIT",
  "RUN_RED_TEAM_PASS",
]);
export type HandoffRequestType = z.infer<typeof HandoffRequestTypeSchema>;

export const HandoffBundleSchema = z.object({
  runId: z.string(),
  ventureId: z.string(),
  type: HandoffRequestTypeSchema,
  createdAt: z.string(),
  ventureRoot: z.string(),
  artifactRefs: z.array(ArtifactRefSchema).default([]),
  payload: z.record(z.unknown()).default({}),
  schemaVersion: z.literal(1).default(1),
});
export type HandoffBundle = z.infer<typeof HandoffBundleSchema>;

export const HandoffStatusSchema = z.enum([
  "accepted",
  "running",
  "success",
  "failed",
  "cancelled",
]);
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;

export const HandoffProgressEventSchema = z.object({
  runId: z.string(),
  status: HandoffStatusSchema,
  message: z.string().optional(),
  percentComplete: z.number().min(0).max(100).optional(),
  emittedAt: z.string(),
});
export type HandoffProgressEvent = z.infer<typeof HandoffProgressEventSchema>;

export const HandoffResultSchema = z.object({
  runId: z.string(),
  ventureId: z.string(),
  status: HandoffStatusSchema,
  producedArtifacts: z.array(ArtifactRefSchema).default([]),
  auditSummary: AuditSummarySchema.optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  completedAt: z.string(),
  schemaVersion: z.literal(1).default(1),
});
export type HandoffResult = z.infer<typeof HandoffResultSchema>;

// --- Handoff export (provider-emitted artifact consumed by BUILD) ---
//
// Both Stitch and Open CoDesign emit a single normalized shape so BUILD doesn't
// have to know which provider produced the artifact. CoDesign populates
// `parameters` (parametric sliders) and `tokens`; Stitch leaves them undefined.

export const HandoffSourceSchema = z.enum(["stitch", "codesign"]);
export type HandoffSource = z.infer<typeof HandoffSourceSchema>;

export const SliderParamSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
  type: z.enum(["number", "color", "select"]).default("number"),
  value: z.union([z.number(), z.string()]),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  options: z.array(z.string()).optional(),
  // CSS variable this slider drives, e.g. "--brand-primary". Optional so
  // non-CSS parameters (logical knobs) can also flow through.
  cssVar: z.string().optional(),
});
export type SliderParam = z.infer<typeof SliderParamSchema>;

export const DesignTokensSchema = z
  .object({
    colors: z.record(z.string()).optional(),
    typography: z
      .object({
        fontFamily: z.string().optional(),
        scale: z.record(z.union([z.number(), z.string()])).optional(),
      })
      .optional(),
    spacing: z.record(z.union([z.number(), z.string()])).optional(),
    radii: z.record(z.union([z.number(), z.string()])).optional(),
    shadows: z.record(z.string()).optional(),
  })
  .passthrough();
export type DesignTokens = z.infer<typeof DesignTokensSchema>;

export const HandoffExportSchema = z
  .object({
    source: HandoffSourceSchema,
    schemaVersion: z.literal(1).default(1),
    // Generated UI markup (CoDesign emits this directly; Stitch leaves it
    // undefined unless the founder pastes the result of running the prompt
    // back into the venture). Optional so the artifact is well-formed even
    // for prompt-only handoffs.
    html: z.string().optional(),
    // Design-AI prompt -- Stitch emits this; CoDesign may set it for
    // generation notes / hint text but typically leaves it undefined.
    prompt: z.string().optional(),
    // Parametric sliders -- emitted by CoDesign, omitted by Stitch.
    parameters: z.record(SliderParamSchema).optional(),
    tokens: DesignTokensSchema.optional(),
    generatedAt: z.string(),
    // Provider tool version for diagnostics, e.g. "codesign@0.4.2" or "stitch@v2".
    providerVersion: z.string().optional(),
    notes: z.string().optional(),
  })
  // BUILD treats html-or-prompt as the minimum viable payload. A Stitch
  // export with no prompt or a CoDesign export with no html is a bug.
  .refine((e) => Boolean(e.html?.trim() || e.prompt?.trim()), {
    message: "HandoffExport must have either html or prompt populated",
  });
export type HandoffExport = z.infer<typeof HandoffExportSchema>;

// --- Validation helpers (the whole point of this package) ---

export function parseBundle(raw: unknown): HandoffBundle {
  return HandoffBundleSchema.parse(raw);
}

export function safeParseBundle(raw: unknown) {
  return HandoffBundleSchema.safeParse(raw);
}

export function parseResult(raw: unknown): HandoffResult {
  return HandoffResultSchema.parse(raw);
}

export function safeParseResult(raw: unknown) {
  return HandoffResultSchema.safeParse(raw);
}

export function parseHandoffExport(raw: unknown): HandoffExport {
  return HandoffExportSchema.parse(raw);
}

export function safeParseHandoffExport(raw: unknown) {
  return HandoffExportSchema.safeParse(raw);
}

export function generateRunId(): string {
  // timestamp + random suffix; good enough for filesystem-scoped uniqueness
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `run-${ts}-${rand}`;
}
