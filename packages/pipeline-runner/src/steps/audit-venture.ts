/**
 * Audit step — runs a battery of sanity checks against the venture state
 * AFTER all earlier pipeline steps have completed. Produces an
 * `AuditFinding[]` array that the orchestrator surfaces in its result;
 * the desktop persists those into the `audit_findings` table keyed by
 * runId so the Audit tab can render historical results.
 *
 * Two flavours of checks:
 *   - **Filesystem presence**: brand brief / spec / stitch config / inbox
 *     were actually written to disk by the earlier steps.
 *   - **Manifest sanity**: business-structure red flags (e.g. sole-trader
 *     taking payments or hiring staff, regulated venture flagged as not
 *     handling personal data).
 *
 * Checks are pure and deterministic — they run on whatever's already on
 * disk, no LLM calls — so this step is fast and safe to run every time.
 *
 * Stage-aware filtering (pt.19):
 * ------------------------------
 * Every rule is tagged with a `minStage` — the earliest `VentureStage` at
 * which the rule is expected to be relevant. At audit time we resolve a
 * `currentStage` (explicit `ctx.ventureStage` ?? `manifest.currentStage`)
 * and skip any rule whose minStage is ahead of it.
 *
 * Why: running the pipeline on a venture at IDEA stage would otherwise
 * flag brand/stitch/build artifacts that aren't yet expected to exist,
 * producing a wall of noise findings the user can't meaningfully act on.
 * With the filter, an IDEA-stage venture sees only manifest-sanity rules;
 * brand findings kick in once the user advances to BRAND_READY, etc.
 *
 * The stage ordering comes from `VENTURE_STAGE_ORDER` in `@founder-os/domain`
 * — kept in one place so a future stage-reshuffle doesn't require edits
 * here.
 */
import { createLogger } from "@founder-os/logger";
import {
  getHandoffsRoot,
  getLogoExportsDir,
  getBrandKitDir,
  getBriefDir,
  getStitchDir,
  getUkSetupCanvasPath,
  getSpecCanvasPath,
  getScreensCanvasPath,
} from "@founder-os/workspace-core";
import type { AuditFinding, AuditSeverity } from "@founder-os/audit-contract";
import type { VentureManifest, VentureStage } from "@founder-os/domain";
import {
  VENTURE_STAGE_ORDER,
  UkSetupCanvasSchema,
  deriveUkSetupRules,
  ProductSpecCanvasSchema,
  deriveProductSpecRules,
  ScreensCanvasSchema,
  deriveScreensRules,
} from "@founder-os/domain";
import type { Filesystem } from "../fs.js";

/**
 * pt.34b — Severity for each UK Setup must-have rule. The rule shape
 * itself (`UkSetupRule`) is jurisdiction-neutral by design and only
 * carries pass/fail; severity is an audit-tier concern (some misses are
 * cosmetic, others are legal liabilities), so we map here.
 *
 * Rules not present in this map fall through to "medium" — a safe
 * default that surfaces in the Audit tab without blocking pass status.
 * Add an entry here when a new rule lands in `deriveUkSetupRules`.
 */
const UK_SETUP_RULE_SEVERITY: Record<string, AuditSeverity> = {
  // Entity decision: by UK_SETUP_READY this should be settled. Medium
  // because everything else cascades from it but it's not illegal.
  "entity.decided": "medium",
  // Ltd-specific: a Ltd venture without a name / SIC / address can't
  // file with Companies House — high because it blocks incorporation.
  "company.name": "high",
  "company.sic": "medium",
  "company.address": "medium",
  // IP assignment: critical — Ltd ventures whose founders haven't
  // assigned pre-incorporation IP to the company don't legally own
  // their own product, which torpedoes due diligence at exit.
  "ip.assigned": "critical",
  // HMRC: UTR is universal but only "medium" because HMRC issues it
  // automatically post-registration, so a missing UTR usually means
  // "haven't registered yet" rather than a permanent gap.
  "hmrc.utr": "medium",
  // PAYE / employer's liability: legally required when hiring staff.
  // Employer's liability has direct fines (HSE) so it's critical.
  "hmrc.paye": "high",
  "insurance.employers": "critical",
  // Banking: sloppy when missing but not illegal — co-mingling personal
  // and business funds is a record-keeping hazard, not a regulator one.
  "banking.active": "low",
  // Insurance recommendations — soft warnings.
  "insurance.professional": "low",
  "insurance.cyber": "low",
};

/**
 * pt.41h — Severity for each Spec must-have rule. Same shape as the
 * UK Setup map: rule.id → severity. Spec rules are mostly "medium"
 * because a missing spec section blocks downstream stages (wireframe,
 * stitch, build) but isn't a legal/regulatory issue. Two are "high":
 * purpose (no purpose = no spec) and at-least-one Must feature
 * (no MVP scope = no v1).
 *
 * Rules not present fall through to "medium" (the default). Add an
 * entry when a new rule lands in `deriveProductSpecRules`.
 */
const SPEC_RULE_SEVERITY: Record<string, AuditSeverity> = {
  // Purpose: foundation. Without it the rest of the spec drifts.
  "purpose.set": "high",
  // Personas: at least one is a basic gate.
  "personas.at-least-one": "medium",
  // Features: at least one Must with AC is the MVP scope itself.
  "features.at-least-one-must": "high",
  "features.acceptance-criteria": "medium",
  // Scope boundary: low because it's mostly a documentation
  // discipline issue, not a build blocker.
  "scope.boundary-set": "low",
  // Data model: medium — wireframes are unblocked without it but
  // build won't start cleanly.
  "data-model.at-least-one-entity": "medium",
  // API: same tier as data model.
  "api.at-least-one-endpoint": "medium",
  // NFRs: low because they're often added during build review.
  "nfr.at-least-one": "low",
  // Metrics: low — important for measurement but not for shipping v1.
  "metrics.at-least-one": "low",
};

/**
 * pt.43 — Severity for each Screens must-have rule. Same shape as
 * SPEC_RULE_SEVERITY: rule.id → severity. Adding a rule to
 * `deriveScreensRules` (in domain/src/screens.ts) lands it in both
 * the ScreensTab's must-haves panel AND the audit findings. Severity
 * MUST get an entry here (or it falls through to "medium").
 *
 * All Screens rules sit at "medium" or "low": the screen inventory
 * is downstream of the spec, so a missing screen doesn't block legal
 * compliance or even spec completion — it just means the stitch pack
 * (pt.44) has thinner per-screen direction. The harder gates are in
 * the spec (purpose / Must features / etc.) and the build.
 */
const SCREEN_RULE_SEVERITY: Record<string, AuditSeverity> = {
  // At least one screen: medium — without screens the stitch pack
  // can't go beyond the hardcoded ["onboarding", "dashboard",
  // "settings"] fallback, but that fallback still lets the founder
  // proceed.
  "at-least-one": "medium",
  // Shell types set: low — defaults to DASHBOARD on the schema, so
  // this only fires if a future schema change makes shellType
  // optional. Defensive entry.
  "shell-types-set": "low",
  // Must-feature coverage: medium — a Must feature with no screen
  // means the stitch pack will get nothing for that feature. Real
  // gap, but not a block: the spec itself is still valid.
  "must-feature-coverage": "medium",
};

const log = createLogger("pipeline-runner:audit-venture");

export type AuditVentureContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
  /**
   * Current venture stage — used to filter rules whose minStage is ahead
   * of where the venture actually is. Optional for backward compat; if
   * omitted we fall back to `manifest.currentStage`. Callers that hold an
   * authoritative DB stage (e.g. the desktop app) should pass it
   * explicitly, because the on-disk manifest can lag behind DB updates.
   */
  ventureStage?: VentureStage;
};

export type AuditVentureResult = {
  status: string;
  producedArtifactIds: string[];
  findings: AuditFinding[];
  /**
   * Number of rules that didn't fire because their minStage was ahead of
   * the venture's current stage. Useful for logs / debugging / a future
   * "N rules deferred until BRAND_READY" affordance in the Audit tab.
   */
  skippedForStage: number;
};

/**
 * Returns true if a rule tagged with `minStage` should fire at
 * `currentStage` — i.e. current is at or after min in the canonical
 * pipeline stage order.
 *
 * Unknown stages (shouldn't happen — the enum is exhaustive) are treated
 * as "current is at IDEA", which makes the filter strictly conservative:
 * rules fire unless we're confident current is behind.
 */
function shouldFireAtStage(
  minStage: VentureStage,
  currentStage: VentureStage
): boolean {
  const minIdx = VENTURE_STAGE_ORDER.indexOf(minStage);
  const curIdx = VENTURE_STAGE_ORDER.indexOf(currentStage);
  // A missing current (should be impossible) → fire everything so we
  // don't silently hide findings on an enum drift. A missing min (rule
  // author typo) → always fire, same rationale.
  if (curIdx === -1 || minIdx === -1) return true;
  return curIdx >= minIdx;
}

export async function auditVentureStep(
  ctx: AuditVentureContext
): Promise<AuditVentureResult> {
  const findings: AuditFinding[] = [];
  const { manifest, ventureRoot, fs } = ctx;

  // Resolve the stage the audit runs against. Explicit param wins — the
  // desktop passes `venture.stage` from the DB (authoritative), because
  // the on-disk manifest lags (handleStageChange only updates the DB,
  // not venture.yaml). Node callers (seed script) that don't pass an
  // explicit stage get manifest.currentStage, which is fine because the
  // seed script writes the manifest before running the audit.
  const currentStage: VentureStage =
    ctx.ventureStage ?? manifest.currentStage;

  // Tracks how many rules were silently skipped because current stage is
  // behind the rule's minStage. Surfaced on the result + in the log so a
  // "nothing fired" outcome can be distinguished from "everything passed".
  let skippedForStage = 0;

  /**
   * Push a finding only if the venture is at or beyond the rule's
   * minStage. Every rule must use this helper — direct `findings.push`
   * would bypass the filter and reintroduce the noise this whole pass
   * was meant to fix.
   */
  const pushFinding = (minStage: VentureStage, finding: AuditFinding): void => {
    if (shouldFireAtStage(minStage, currentStage)) {
      findings.push(finding);
    } else {
      skippedForStage += 1;
    }
  };

  // ── Artifact presence ────────────────────────────────────────────────
  // Paths go through workspace-core helpers wherever possible so a future
  // rename of `03_brand/` doesn't silently break the audit.
  const brandKitDir = getBrandKitDir(ventureRoot);
  const brandBriefPath = `${brandKitDir}/brand-brief.json`;
  const tokensPath = `${brandKitDir}/tokens.json`;
  const logoExportsDir = getLogoExportsDir(ventureRoot);
  const logoSvgPath = `${logoExportsDir}/logo.svg`;
  const briefDir = getBriefDir(ventureRoot);
  const devBriefPath = `${briefDir}/dev-brief.md`;
  const specPath = `${ventureRoot}/06_product/specs/product-spec.md`;
  const stitchDir = getStitchDir(ventureRoot);
  const stitchPath = `${stitchDir}/stitch-config.json`;
  const readmePath = `${ventureRoot}/README.md`;
  const inboxDir = `${getHandoffsRoot(ventureRoot)}/inbox`;

  if (!(await fs.exists(brandBriefPath))) {
    pushFinding("BRAND_READY", {
      ruleId: "artifact.brand-brief.missing",
      severity: "high",
      title: "Brand brief missing",
      message:
        "Expected brand-brief.json at 03_brand/brand-kit/. Earlier step may have failed.",
      evidence: [{ filePath: brandBriefPath }],
    });
  }

  if (!(await fs.exists(specPath))) {
    pushFinding("SPEC_READY", {
      ruleId: "artifact.product-spec.missing",
      severity: "high",
      title: "Product spec missing",
      message:
        "Expected product-spec.md at 06_product/specs/. Earlier step may have failed.",
      evidence: [{ filePath: specPath }],
    });
  }

  if (!(await fs.exists(stitchPath))) {
    pushFinding("STITCH_READY", {
      ruleId: "artifact.stitch-config.missing",
      severity: "medium",
      title: "Stitch config missing",
      message:
        "No stitch-config.json — the VS Code builder won't have a design-to-code prompt to chew on.",
      evidence: [{ filePath: stitchPath }],
    });
  }

  if (!(await fs.exists(inboxDir))) {
    pushFinding("BUILD_READY", {
      ruleId: "handoff.inbox.missing",
      severity: "high",
      title: "Handoff inbox directory missing",
      message:
        "Expected handoffs/inbox after create-build-handoff — bundle won't reach the VS Code extension.",
      evidence: [{ filePath: inboxDir }],
    });
  }

  if (!(await fs.exists(logoSvgPath))) {
    pushFinding("BRAND_READY", {
      ruleId: "artifact.logo.missing",
      severity: "medium",
      title: "Logo SVG missing",
      message:
        "Expected logo.svg in 03_brand/logo/exports/. materializeBrandPack either failed or the step was skipped.",
      evidence: [{ filePath: logoSvgPath }],
    });
  }

  if (!(await fs.exists(devBriefPath))) {
    pushFinding("SPEC_READY", {
      ruleId: "artifact.dev-brief.missing",
      severity: "high",
      title: "Dev brief missing",
      message:
        "Expected dev-brief.md in 06_product/brief/. The ensure-brief step normally scaffolds this.",
      evidence: [{ filePath: devBriefPath }],
    });
  }

  if (!(await fs.exists(readmePath))) {
    pushFinding("BUILD_READY", {
      ruleId: "artifact.readme.missing",
      severity: "low",
      title: "README missing at venture root",
      message:
        "No README.md at the venture root. Not required, but handy context for future-you and anyone else skimming the folder.",
      evidence: [{ filePath: readmePath }],
    });
  }

  // ── Tokens.json shape ────────────────────────────────────────────────
  if (await fs.exists(tokensPath)) {
    try {
      const raw = await fs.readFile(tokensPath);
      const tokens = JSON.parse(raw) as Record<string, unknown>;
      // materializeBrandPack emits `colors`/`typography` at minimum — if
      // neither is present, something's likely wrong with the generator.
      if (!tokens.colors && !tokens.typography) {
        pushFinding("BRAND_READY", {
          ruleId: "tokens.content.empty",
          severity: "medium",
          title: "Design tokens look empty",
          message:
            "tokens.json exists but has no `colors` or `typography` — downstream Tailwind preset will be blank.",
          evidence: [{ filePath: tokensPath }],
        });
      }
    } catch (err) {
      pushFinding("BRAND_READY", {
        ruleId: "tokens.json.invalid",
        severity: "high",
        title: "Design tokens JSON invalid",
        message: err instanceof Error ? err.message : String(err),
        evidence: [{ filePath: tokensPath }],
      });
    }
  } else {
    pushFinding("BRAND_READY", {
      ruleId: "artifact.tokens.missing",
      severity: "medium",
      title: "Design tokens missing",
      message:
        "Expected tokens.json in 03_brand/brand-kit/. Without it, the Tailwind preset can't be generated.",
      evidence: [{ filePath: tokensPath }],
    });
  }

  // ── Stitch config shape / length ─────────────────────────────────────
  if (await fs.exists(stitchPath)) {
    try {
      const raw = await fs.readFile(stitchPath);
      const stitch = JSON.parse(raw) as { prompts?: unknown; prompt?: unknown };
      const promptLen = JSON.stringify(stitch.prompts ?? stitch.prompt ?? "")
        .length;
      if (promptLen < 200) {
        pushFinding("STITCH_READY", {
          ruleId: "stitch.prompt.too-short",
          severity: "low",
          title: "Stitch prompt is thin",
          message: `Prompt payload is only ~${promptLen} chars. Stitch / v0 / Figma Make usually need richer context to produce usable layouts.`,
          evidence: [{ filePath: stitchPath }],
        });
      }
    } catch (err) {
      pushFinding("STITCH_READY", {
        ruleId: "stitch.json.invalid",
        severity: "high",
        title: "Stitch config JSON invalid",
        message: err instanceof Error ? err.message : String(err),
        evidence: [{ filePath: stitchPath }],
      });
    }
  }

  // ── Brand brief JSON shape ───────────────────────────────────────────
  // Only run if the file exists; otherwise the missing-file finding above
  // already flagged it.
  if (await fs.exists(brandBriefPath)) {
    try {
      const raw = await fs.readFile(brandBriefPath);
      const brief = JSON.parse(raw) as Record<string, unknown>;
      if (typeof brief.name !== "string" || brief.name.length === 0) {
        pushFinding("BRAND_READY", {
          ruleId: "brief.name.missing",
          severity: "medium",
          title: "Brand brief has no name",
          message: "brand-brief.json is missing the `name` field.",
          evidence: [{ filePath: brandBriefPath }],
        });
      }
      if (
        !Array.isArray((brief as { palette?: unknown }).palette) ||
        ((brief as { palette?: unknown[] }).palette ?? []).length === 0
      ) {
        pushFinding("BRAND_READY", {
          ruleId: "brief.palette.missing",
          severity: "low",
          title: "Brand brief has no palette",
          message:
            "brand-brief.json has no `palette` entries; downstream logo/token generation may default to bland colours.",
          evidence: [{ filePath: brandBriefPath }],
        });
      }
    } catch (err) {
      pushFinding("BRAND_READY", {
        ruleId: "brief.json.invalid",
        severity: "high",
        title: "Brand brief JSON invalid",
        message: err instanceof Error ? err.message : String(err),
        evidence: [{ filePath: brandBriefPath }],
      });
    }
  }

  // ── Manifest sanity — business structure ─────────────────────────────
  // All of these are stage-independent: they apply from IDEA onward
  // because they guide the founder's setup decisions before any artifact
  // generation. They'll always fire when the manifest's triggering
  // condition is met.
  if (manifest.regulated && !manifest.handlesPersonalData) {
    pushFinding("IDEA", {
      ruleId: "manifest.regulated.personal-data",
      severity: "medium",
      title: "Regulated venture flagged as not handling personal data",
      message:
        "Regulated businesses almost always handle personal data — double-check the manifest flags before continuing.",
      evidence: [],
    });
  }

  if (manifest.takesPayments && manifest.entityType === "sole_trader") {
    pushFinding("IDEA", {
      ruleId: "manifest.payments.entity-type",
      severity: "low",
      title: "Payments under sole-trader structure",
      message:
        "Sole traders taking payments carry unlimited personal liability. Consider incorporating before scale.",
      evidence: [],
    });
  }

  if (manifest.hiresStaff && manifest.entityType === "sole_trader") {
    pushFinding("IDEA", {
      ruleId: "manifest.hiring.entity-type",
      severity: "medium",
      title: "Hiring under sole-trader structure",
      message:
        "Employers should incorporate — sole-trader wages and NI obligations attach to personal assets.",
      evidence: [],
    });
  }

  // pt.37 — only fire the manifest-side rule BEFORE UK_SETUP_READY.
  // From UK_SETUP_READY onward, the canvas-side `uk-setup.entity.decided`
  // rule is authoritative because the canvas can override the manifest
  // (founder may start as sole_trader and decide Ltd during UK Setup —
  // canvas captures the current truth, manifest is the original intent).
  // Firing both at the same time produced duplicate findings for the same
  // gap, distinguishable only by evidence file. The dedup keeps the early
  // nudge visible at IDEA / RESEARCHED / VALIDATED / BRAND_READY (where
  // the canvas doesn't exist yet) and lets the canvas rule take over
  // afterwards.
  const ukSetupIdx = VENTURE_STAGE_ORDER.indexOf("UK_SETUP_READY");
  const currentIdx = VENTURE_STAGE_ORDER.indexOf(currentStage);
  const beforeUkSetup =
    currentIdx >= 0 && ukSetupIdx >= 0 && currentIdx < ukSetupIdx;

  if (manifest.entityType === "undecided" && beforeUkSetup) {
    pushFinding("IDEA", {
      ruleId: "manifest.entity-type.undecided",
      severity: "low",
      title: "Entity type not yet chosen",
      message:
        "Pick a structure (ltd / sole_trader / partnership) before the UK setup stage — most downstream tasks key off this.",
      evidence: [],
    });
  }

  if (manifest.blockers.length > 0) {
    pushFinding("IDEA", {
      ruleId: "manifest.blockers.present",
      severity: "medium",
      title: `${manifest.blockers.length} open blocker(s)`,
      message: `Blockers listed on manifest: ${manifest.blockers.join("; ")}`,
      evidence: [],
    });
  }

  // ── UK Setup canvas (pt.34b) ─────────────────────────────────────────
  // The pipeline step `ensure-uk-setup` (pt.33d) writes the canvas on
  // entering UK_SETUP_READY. Audit reads the canvas + manifest flags
  // and runs them through `deriveUkSetupRules` — single source of truth
  // shared with the UkSetupTab's must-haves panel, so a rule that fails
  // in the UI also fails here. Each unmet rule becomes a finding with
  // severity from UK_SETUP_RULE_SEVERITY above.
  const ukCanvasPath = getUkSetupCanvasPath(ventureRoot);
  if (await fs.exists(ukCanvasPath)) {
    try {
      const raw = await fs.readFile(ukCanvasPath);
      const parsed = UkSetupCanvasSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        pushFinding("UK_SETUP_READY", {
          ruleId: "uk-setup.json.invalid",
          severity: "high",
          title: "UK Setup canvas JSON invalid",
          message:
            "uk-setup.json failed schema validation. The pipeline step leaves hand-edited files alone — fix manually or delete and re-run the pipeline.",
          evidence: [{ filePath: ukCanvasPath }],
        });
      } else {
        const canvas = parsed.data;
        // Derive must-haves with the manifest's flags (same call the
        // UkSetupTab makes). Failing rules → findings; passing rules
        // are silent. minStage UK_SETUP_READY across the board because
        // these only make sense once the founder has reached the UK
        // admin stage of the pipeline.
        const rules = deriveUkSetupRules(canvas, {
          hiresStaff: manifest.hiresStaff,
          handlesPersonalData: manifest.handlesPersonalData,
          takesPayments: manifest.takesPayments,
        });
        for (const rule of rules) {
          if (rule.pass) continue;
          const severity = UK_SETUP_RULE_SEVERITY[rule.id] ?? "medium";
          pushFinding("UK_SETUP_READY", {
            ruleId: `uk-setup.${rule.id}`,
            severity,
            title: rule.label,
            message: `${rule.description}. Open the UK Setup tab to fill this in.`,
            evidence: [{ filePath: ukCanvasPath }],
          });
        }

        // ── pt.35 — UTR format tripwire ──────────────────────────────
        // Soft-warn when the founder has recorded a UTR but it doesn't
        // resolve to exactly 10 digits. Complements the must-haves
        // `hmrc.utr` rule (which fires on empty); this fires on
        // PRESENT-but-malformed. Severity low because the canvas
        // accepts any string by design (mid-edit values shouldn't
        // block save) — the audit is where format checks belong, per
        // pt.33 deliberately-did-not policy.
        //
        // HMRC UTR canonical format: 10 digits. Often printed with
        // whitespace or a 5-5 split, occasionally a trailing "K"
        // checksum marker on Self Assessment statements. We strip all
        // non-digits and verify the resulting count rather than
        // pattern-matching the surface — copy-paste from a letter
        // shouldn't fail the rule for a stray space.
        const utrRaw = canvas.hmrc.utrNumber.trim();
        if (utrRaw.length > 0) {
          const utrDigits = utrRaw.replace(/\D/g, "");
          if (utrDigits.length !== 10) {
            pushFinding("UK_SETUP_READY", {
              ruleId: "uk-setup.utr-format-invalid",
              severity: "low",
              title: "UTR format looks off",
              message:
                `HMRC UTRs are exactly 10 digits — got ${utrDigits.length} ` +
                `(recorded value: "${utrRaw}"). Check your HMRC welcome ` +
                `letter or Self Assessment statement.`,
              evidence: [{ filePath: ukCanvasPath }],
            });
          }
        }

        // ── pt.38 — VAT number format tripwire ────────────────────────
        // Mirror of the UTR check. UK VAT numbers are 9 digits in their
        // canonical form (e.g. `123456789`) or 12 digits when carrying a
        // branch suffix (the 9-digit base + 3-digit branch). HMRC also
        // accepts a "GB" prefix on EU-facing invoices, but that's not a
        // digit so the strip handles it. Same severity / canvas-edit
        // policy as the UTR rule: low, audit-only, doesn't block save.
        //
        // Only fires when `vatRegistered` is true AND a number has been
        // typed — a not-yet-registered founder won't have one to put in,
        // and an empty string at vatRegistered=true is already caught by
        // the surrounding workflow (the must-haves rules don't currently
        // require it, but if/when they do, this complements rather than
        // duplicates).
        if (canvas.hmrc.vatRegistered) {
          const vatRaw = canvas.hmrc.vatNumber.trim();
          if (vatRaw.length > 0) {
            const vatDigits = vatRaw.replace(/\D/g, "");
            if (vatDigits.length !== 9 && vatDigits.length !== 12) {
              pushFinding("UK_SETUP_READY", {
                ruleId: "uk-setup.vat-format-invalid",
                severity: "low",
                title: "VAT number format looks off",
                message:
                  `UK VAT numbers are 9 digits (or 12 with a branch ` +
                  `suffix) — got ${vatDigits.length} (recorded value: ` +
                  `"${vatRaw}"). The "GB" prefix is fine; the digit count ` +
                  `is what matters.`,
                evidence: [{ filePath: ukCanvasPath }],
              });
            }
          }
        }

        // ── pt.40a — Company number format tripwire ───────────────────
        // Companies House numbers are exactly 8 characters: either all
        // digits (England & Wales, the common case) OR a 2-letter prefix
        // + 6 digits for the regional / specialist registers — SC for
        // Scotland, NI for Northern Ireland, OC for LLPs, FC for foreign
        // companies, NF for Northern Ireland LLPs, etc. We check
        // length === 8 and `[A-Za-z0-9]` to cover all variants without
        // having to maintain a prefix list (which Companies House
        // occasionally extends).
        //
        // Whitespace (none expected, but copy-paste happens) is
        // stripped before length-checking; the surface is recorded
        // back into the message verbatim so the founder sees what they
        // wrote, not the cleaned form.
        if (canvas.entityType === "ltd") {
          const cnRaw = canvas.company.companyNumber.trim();
          if (cnRaw.length > 0) {
            const cnClean = cnRaw.replace(/\s+/g, "");
            const validShape = /^[A-Za-z0-9]{8}$/.test(cnClean);
            if (!validShape) {
              pushFinding("UK_SETUP_READY", {
                ruleId: "uk-setup.company-number-format-invalid",
                severity: "low",
                title: "Company number format looks off",
                message:
                  `Companies House numbers are 8 characters — either 8 ` +
                  `digits or a 2-letter prefix (SC / NI / OC / FC / NF / ` +
                  `etc.) followed by 6 digits. Got "${cnRaw}" (${cnClean.length} ` +
                  `chars after stripping whitespace). Check the ` +
                  `incorporation certificate.`,
                evidence: [{ filePath: ukCanvasPath }],
              });
            }
          }
        }

        // ── pt.40b — Registered-office postcode format tripwire ───────
        // UK postcodes follow a well-known shape: 1-2 letters, 1 digit,
        // an optional letter or digit, then 1 digit and 2 letters,
        // optionally with a single space separating the two halves
        // (e.g. "SW1A 1AA", "M1 1AE", "B33 8TH", "EC1A 1BB"). We use the
        // commonly-cited regex below; it intentionally doesn't try to
        // catch GIR 0AA (Girobank) or BFPO addresses — those are real
        // but rare enough that a low-severity false positive is fine.
        //
        // Ltd-only because registered-office is a Ltd concept. Sole
        // traders and partnerships use the founder's address but don't
        // surface it here (the canvas's address field is gated behind
        // entityType === "ltd" in the UI).
        if (canvas.entityType === "ltd") {
          const pcRaw = canvas.company.registeredOffice.postcode.trim();
          if (pcRaw.length > 0) {
            const ukPostcode = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
            if (!ukPostcode.test(pcRaw)) {
              pushFinding("UK_SETUP_READY", {
                ruleId: "uk-setup.postcode-format-invalid",
                severity: "low",
                title: "Postcode format looks off",
                message:
                  `Doesn't match the standard UK postcode shape ` +
                  `(e.g. "SW1A 1AA", "M1 1AE"). Got "${pcRaw}". If this ` +
                  `is a GIR / BFPO address, ignore — the rule's regex ` +
                  `intentionally skips those edge cases.`,
                evidence: [{ filePath: ukCanvasPath }],
              });
            }
          }
        }
      }
    } catch (err) {
      // JSON.parse threw (vs Zod failing) — still treat as invalid so
      // the founder gets a finding. Same reasoning as the brand-brief
      // / tokens.json blocks above.
      pushFinding("UK_SETUP_READY", {
        ruleId: "uk-setup.json.invalid",
        severity: "high",
        title: "UK Setup canvas JSON invalid",
        message: err instanceof Error ? err.message : String(err),
        evidence: [{ filePath: ukCanvasPath }],
      });
    }
  } else {
    // Missing file at UK_SETUP_READY+ means the pipeline step hasn't
    // run (or someone deleted the file). High because the UkSetupTab
    // can't render — the deterministic step is supposed to scaffold
    // an empty canvas before the founder ever lands on the tab.
    pushFinding("UK_SETUP_READY", {
      ruleId: "uk-setup.canvas.missing",
      severity: "high",
      title: "UK Setup canvas missing",
      message:
        "Expected uk-setup.json at 04_uk_business/. Re-run the pipeline to scaffold it.",
      evidence: [{ filePath: ukCanvasPath }],
    });
  }

  // ── Spec canvas (pt.41h) ──────────────────────────────────────────
  // Mirrors the UK Setup canvas section above. Reads spec-canvas.json,
  // runs deriveProductSpecRules (single source of truth shared with
  // the SpecTab's must-haves panel), emits findings for each unmet
  // rule at minStage SPEC_READY. Same three failure modes for the
  // canvas read: missing, Zod fail, JSON.parse throw.
  //
  // Severity map is SPEC_RULE_SEVERITY; rules without an entry fall
  // through to "medium". The pipeline step `ensure-spec` (pt.41c)
  // creates the canvas when entering SPEC_READY, so a missing canvas
  // at SPEC_READY+ means the step didn't run or someone deleted the
  // file — high severity.
  const specCanvasPath = getSpecCanvasPath(ventureRoot);
  if (await fs.exists(specCanvasPath)) {
    try {
      const raw = await fs.readFile(specCanvasPath);
      const parsed = ProductSpecCanvasSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        pushFinding("SPEC_READY", {
          ruleId: "spec.json.invalid",
          severity: "high",
          title: "Spec canvas JSON invalid",
          message:
            "spec-canvas.json failed schema validation. The pipeline step leaves hand-edited files alone — fix manually or delete and re-run the pipeline.",
          evidence: [{ filePath: specCanvasPath }],
        });
      } else {
        const canvas = parsed.data;
        const rules = deriveProductSpecRules(canvas);
        for (const rule of rules) {
          if (rule.pass) continue;
          const severity = SPEC_RULE_SEVERITY[rule.id] ?? "medium";
          pushFinding("SPEC_READY", {
            ruleId: `spec.${rule.id}`,
            severity,
            title: rule.label,
            message: `${rule.description}. Open the Spec tab to fill this in.`,
            evidence: [{ filePath: specCanvasPath }],
          });
        }

        // ── pt.42b.1 — Endpoint path format tripwire ─────────────────
        // Soft-warn on endpoints whose `path` is set but doesn't look
        // like a valid REST path or RPC operation name. The canvas
        // accepts any string by design — founders type partial paths
        // mid-edit (per pt.41 deliberately-did-not policy) — so format
        // checks belong in the audit, not the schema. Mirror of the
        // pt.35 (UTR), pt.38 (VAT), pt.40a (company number), pt.40b
        // (postcode) tripwire shape.
        //
        // Two valid shapes (per ApiEndpointSchema doc comment, line
        // 130 of `domain/src/spec.ts`):
        //   - REST path: starts with "/" and has no whitespace —
        //     e.g. "/api/projects", "/users/:id", "/v1/auth/login".
        //   - RPC operation: an identifier-ish word starting with a
        //     letter — e.g. "createProject", "auth.login",
        //     "user_signup". Allows "." / "_" / "-" so namespaced
        //     RPC styles (tRPC, JSON-RPC) and kebab-case both work.
        //
        // We DON'T validate route-param syntax — ":id" / "{id}" /
        // "<id>" are all in-the-wild conventions and the canvas is
        // framework-agnostic. We DO flag full URLs ("https://...")
        // because the field is `path`, not `url` — pasting a full
        // URL is a common copy-paste mistake.
        //
        // Rolled into a single finding listing all bad paths (same
        // pattern as `manifest.blockers.present`) rather than emitting
        // N findings with the same ruleId, which would clutter the
        // Audit tab and make INSERT OR REPLACE behaviour ambiguous.
        const badPaths: string[] = [];
        for (const endpoint of canvas.apiSurface.endpoints) {
          const pathRaw = endpoint.path.trim();
          if (pathRaw.length === 0) continue;
          const looksLikeUrl = /^https?:\/\//i.test(pathRaw);
          const validRest = /^\/\S*$/.test(pathRaw);
          const validRpc = /^[A-Za-z][A-Za-z0-9_.-]*$/.test(pathRaw);
          if (looksLikeUrl || (!validRest && !validRpc)) {
            badPaths.push(`${endpoint.method} ${pathRaw}`);
          }
        }
        if (badPaths.length > 0) {
          pushFinding("SPEC_READY", {
            ruleId: "spec.endpoint-path-format-invalid",
            severity: "low",
            title: `${badPaths.length} endpoint path(s) look malformed`,
            message:
              `Paths should be either a REST path starting with "/" ` +
              `(e.g. "/api/projects") or an RPC operation name ` +
              `(e.g. "createProject"). Drop any leading "http(s)://" ` +
              `— this field is a path, not a full URL. Flagged: ` +
              `${badPaths.join("; ")}.`,
            evidence: [{ filePath: specCanvasPath }],
          });
        }

        // ── pt.42b.2 — Persona-feature linkage rule ──────────────────
        // Every named persona should have at least one Must-priority
        // feature targeting them. Surfaces personas that exist on the
        // canvas but no Must feature points back at them — usually
        // either an unused persona (delete) or a coverage gap (add a
        // feature). Severity low: it's a soft prompt; the harder gates
        // (`personas.at-least-one`, `features.at-least-one-must`) are
        // already covered by deriveProductSpecRules above.
        //
        // Skips silently if the canvas has no personas — the empty
        // state is covered by `personas.at-least-one`.
        //
        // Per FeatureSchema.personaId doc (line 81 of `spec.ts`):
        // empty string = "serves all personas equally". So a single
        // universal Must (`personaId: ""`) satisfies the rule for
        // every persona — we early-exit when one exists. Non-empty
        // personaIds get collected into a Set and matched against
        // each persona's id; named personas not in that set surface
        // in the finding. Unnamed (in-progress) personas are skipped
        // — they're WIP rows, not real coverage gaps.
        if (canvas.personas.length > 0) {
          const hasUniversalMust = canvas.features.some(
            (f) =>
              f.priority === "must" && f.personaId.trim().length === 0
          );
          if (!hasUniversalMust) {
            const coveredIds = new Set(
              canvas.features
                .filter(
                  (f) =>
                    f.priority === "must" &&
                    f.personaId.trim().length > 0
                )
                .map((f) => f.personaId)
            );
            const uncovered = canvas.personas
              .filter((p) => p.name.trim().length > 0)
              .filter((p) => !coveredIds.has(p.id))
              .map((p) => p.name);
            if (uncovered.length > 0) {
              pushFinding("SPEC_READY", {
                ruleId: "spec.persona-feature-linkage",
                severity: "low",
                title: `${uncovered.length} persona(s) without Must-feature coverage`,
                message:
                  `Every named persona should have at least one ` +
                  `Must-priority feature targeting them via personaId. ` +
                  `Personas with no coverage: ${uncovered.join("; ")}. ` +
                  `Either add a Must feature with this persona's id, ` +
                  `or leave a Must feature's persona empty (which ` +
                  `means "serves all personas equally").`,
                evidence: [{ filePath: specCanvasPath }],
              });
            }
          }
        }
      }
    } catch (err) {
      pushFinding("SPEC_READY", {
        ruleId: "spec.json.invalid",
        severity: "high",
        title: "Spec canvas JSON invalid",
        message: err instanceof Error ? err.message : String(err),
        evidence: [{ filePath: specCanvasPath }],
      });
    }
  } else {
    pushFinding("SPEC_READY", {
      ruleId: "spec.canvas.missing",
      severity: "high",
      title: "Spec canvas missing",
      message:
        "Expected spec-canvas.json at 06_product/specs/. Re-run the pipeline to scaffold it.",
      evidence: [{ filePath: specCanvasPath }],
    });
  }

  // ── Screens canvas (pt.43) ────────────────────────────────────────
  // Mirrors the Spec audit block above. Reads screens-canvas.json,
  // runs deriveScreensRules with a spec snapshot (features for the
  // Must-coverage check), emits findings for each unmet rule at
  // minStage WIREFRAME_READY. Three failure modes for the canvas
  // read: missing, Zod fail, JSON.parse throw.
  //
  // The spec snapshot is best-effort: if spec-canvas.json is missing
  // or malformed, we skip just the coverage rule (passing an empty
  // features list). The "at-least-one" and "shell-types-set" rules
  // still fire because they don't depend on the spec.
  //
  // Severity map is SCREEN_RULE_SEVERITY; rules without an entry
  // fall through to "medium". The pipeline step `ensure-screens`
  // (pt.43) creates the canvas when entering WIREFRAME_READY, so a
  // missing canvas at WIREFRAME_READY+ means the step didn't run or
  // someone deleted the file — high severity.
  //
  // Stage gating: WIREFRAME_READY is the legacy enum value for what
  // we now call the "Screens stage" (see screens.ts header for the
  // narrowed-scope policy). Callers see the cue and tab as "Screens"
  // but the persisted stage value stays WIREFRAME_READY for backward
  // compatibility.
  const screensCanvasPath = getScreensCanvasPath(ventureRoot);
  if (await fs.exists(screensCanvasPath)) {
    try {
      const raw = await fs.readFile(screensCanvasPath);
      const parsed = ScreensCanvasSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        pushFinding("WIREFRAME_READY", {
          ruleId: "screens.json.invalid",
          severity: "high",
          title: "Screens canvas JSON invalid",
          message:
            "screens-canvas.json failed schema validation. The pipeline step leaves hand-edited files alone — fix manually or delete and re-run the pipeline.",
          evidence: [{ filePath: screensCanvasPath }],
        });
      } else {
        const canvas = parsed.data;
        // Spec snapshot for the Must-coverage rule. Best-effort —
        // if the spec is missing/malformed we pass an empty list,
        // and `deriveScreensRules` skips the coverage rule entirely
        // (only fires if there ARE Must features to cover). The
        // missing/malformed spec is already flagged by the spec
        // audit block above, so we don't double-report.
        let specFeatures: Array<{
          id: string;
          name: string;
          priority: string;
        }> = [];
        if (await fs.exists(specCanvasPath)) {
          try {
            const rawSpec = await fs.readFile(specCanvasPath);
            const parsedSpec = ProductSpecCanvasSchema.safeParse(
              JSON.parse(rawSpec)
            );
            if (parsedSpec.success) {
              specFeatures = parsedSpec.data.features.map((f) => ({
                id: f.id,
                name: f.name,
                priority: f.priority,
              }));
            }
          } catch {
            // Already flagged by the spec block; suppress here so
            // we don't emit the same parse error under two ruleIds.
          }
        }

        const rules = deriveScreensRules(canvas, {
          features: specFeatures,
        });
        for (const rule of rules) {
          if (rule.pass) continue;
          const severity = SCREEN_RULE_SEVERITY[rule.id] ?? "medium";
          pushFinding("WIREFRAME_READY", {
            ruleId: `screens.${rule.id}`,
            severity,
            title: rule.label,
            message: `${rule.description}. Open the Screens tab to fill this in.`,
            evidence: [{ filePath: screensCanvasPath }],
          });
        }
      }
    } catch (err) {
      pushFinding("WIREFRAME_READY", {
        ruleId: "screens.json.invalid",
        severity: "high",
        title: "Screens canvas JSON invalid",
        message: err instanceof Error ? err.message : String(err),
        evidence: [{ filePath: screensCanvasPath }],
      });
    }
  } else {
    pushFinding("WIREFRAME_READY", {
      ruleId: "screens.canvas.missing",
      severity: "high",
      title: "Screens canvas missing",
      message:
        "Expected screens-canvas.json at 06_product/wireframes/. Re-run the pipeline to scaffold it.",
      evidence: [{ filePath: screensCanvasPath }],
    });
  }

  // pt.36 — Synthetic informational finding when rules were deferred for
  // stage. Without this, a founder at IDEA stage sees an unexplained
  // short list of findings and can't tell whether "few findings" means
  // "everything passed" or "most rules haven't activated yet". Severity
  // low so it doesn't fail the audit (auditPassed only flips on
  // high/critical). Distinctive ruleId prefix (`audit.meta.*`) so a
  // future render path or count-filter can split meta-findings from
  // real ones without string-matching the title.
  //
  // Emitted at the end so it appears at the bottom of the findings list
  // in the AuditTab, where it reads as a footer rather than a finding.
  if (skippedForStage > 0) {
    findings.push({
      ruleId: "audit.meta.deferred-rules",
      severity: "low",
      title: `${skippedForStage} rule(s) deferred until later stages`,
      message:
        `Stage ${currentStage} runs ${findings.length} rule(s); ` +
        `${skippedForStage} more activate as the venture advances. ` +
        `This is informational, not a failure — the deferred rules ` +
        `target artifacts (brand, UK setup, spec, build) that don't ` +
        `exist yet.`,
      evidence: [],
    });
  }

  log.info(
    `Audit produced ${findings.length} finding(s) at stage ${currentStage}` +
      (skippedForStage > 0
        ? ` · ${skippedForStage} rule(s) deferred (minStage ahead of current)`
        : "")
  );
  return {
    status: "done",
    producedArtifactIds: [],
    findings,
    skippedForStage,
  };
}
