/**
 * UK Setup canvas (pt.33) — the founder's UK admin decisions persisted
 * to `04_uk_business/uk-setup.json` in the venture workspace.
 *
 * Mirrors the BrandCanvas pattern (pt.24): partial / WIP-friendly
 * state stored alongside the manifest, recomputed on read where
 * possible, audited via separate rules. The canvas captures decisions
 * the founder MUST make to operate a UK venture legally — entity
 * type, registrations, banking, insurance, IP — without trying to
 * automate any of them. Each section is a concrete checklist a
 * founder would otherwise have to assemble themselves.
 *
 * Why a separate file instead of bolting onto the manifest:
 *   - Manifest is settings (immutable-ish setup); canvas is workflow
 *     state (dates, statuses, evolving fields).
 *   - Canvas can hold partial data without polluting the manifest's
 *     stricter Zod shape — a founder mid-setup has half-filled fields.
 *   - Audit rules can target the canvas independently.
 *
 * The canvas is the single source of truth for UK Setup completeness.
 * `must-haves` gating in the UI derives from the canvas; audit rules
 * read the canvas; stage advance to SPEC_READY checks the canvas.
 */
import { z } from "zod";

/**
 * Local mirror of `EntityTypeSchema` from `index.ts`. We define it
 * here instead of importing to break a circular dependency:
 *   index.ts → `export * from "./uk-setup.js"` → uk-setup.ts → `import EntityTypeSchema from "./index.js"`
 * That cycle was latent for a long time (tsc tolerated it; runtime
 * happened to evaluate index.ts's EntityTypeSchema before uk-setup
 * read it). Adding the screens.ts re-export to index.ts in pt.43
 * shifted Vite/esbuild's evaluation order enough that uk-setup's
 * top-level `entityType: EntityTypeSchema` ran during the TDZ window,
 * giving "Cannot access 'EntityTypeSchema' before initialization" at
 * uk-setup.ts:194:15 in the WebView (typecheck still passed because
 * tsc doesn't enforce ESM TDZ).
 *
 * The schema is a string enum, so a local copy is byte-identical at
 * runtime and structurally identical at the type level — consumers
 * doing `canvas.entityType` get the same `"sole_trader" | "ltd" |
 * "partnership" | "undecided"` union as before.
 *
 * If a third domain file needs the same enum, extract it to a
 * dedicated `manifest-enums.ts` (or similar) and import from there
 * in both index.ts and uk-setup.ts. Don't reintroduce the cycle.
 */
const EntityTypeSchema = z.enum(["sole_trader", "ltd", "partnership", "undecided"]);

// ---------------------------------------------------------------------------
// Sub-shapes
// ---------------------------------------------------------------------------

/**
 * UK postal address. `country` defaults to "GB" (Companies House
 * country codes — GB, IM, JE, GG). Most ventures will be GB.
 */
export const UkAddressSchema = z.object({
  line1: z.string().default(""),
  line2: z.string().default(""),
  city: z.string().default(""),
  postcode: z.string().default(""),
  country: z.string().default("GB"),
});
export type UkAddress = z.infer<typeof UkAddressSchema>;

/**
 * Company details — only meaningful when entityType === "ltd".
 * For sole_trader / partnership the founder fills `name` (trading
 * name) and leaves the rest blank.
 */
export const CompanyDetailsSchema = z.object({
  /** Companies House preferred name (with " Ltd" / " Limited" suffix). */
  name: z.string().default(""),
  /**
   * Companies House registration number, once registered. 8-digit
   * string. Empty until incorporation lands.
   */
  companyNumber: z.string().default(""),
  /**
   * Standard Industrial Classification (SIC) code — Companies House
   * requires at least one. Free-text here so the founder can record
   * "62012 — Business and domestic software development" verbatim
   * from the official list. We don't validate against the SIC list
   * (it's 600+ entries; would be its own data file).
   */
  sicCode: z.string().default(""),
  /** Registered office address. Required for Ltd at incorporation. */
  registeredOffice: UkAddressSchema.default(() => ({
    line1: "",
    line2: "",
    city: "",
    postcode: "",
    country: "GB",
  })),
  /**
   * Date of incorporation as ISO date string (YYYY-MM-DD). Empty
   * until incorporation happens. Used by the audit rules to surface
   * milestone reminders (annual confirmation statement due 12mo
   * after incorporation, etc.).
   */
  incorporatedAt: z.string().default(""),
  /**
   * pt.40d — Last time the founder ran the Companies House public
   * search for this company name, as a full ISO timestamp. Stamped by
   * the UkSetupTab's "Search Companies House" launcher button so the
   * UI can render a "Searched at HH:MM" hint and avoid prompting the
   * founder to re-check what they just looked at. Empty until the
   * first launcher click. Persisted alongside the rest of the canvas.
   */
  nameLastCheckedAt: z.string().default(""),
});
export type CompanyDetails = z.infer<typeof CompanyDetailsSchema>;

/**
 * HMRC + tax registrations. The founder ticks each as they get done;
 * the canvas captures the resulting reference numbers. We don't
 * validate UTR / VAT formats because typos happen and an invalid
 * number is more useful in the file than no number at all (audit
 * rule can flag the format separately).
 */
export const HmrcSetupSchema = z.object({
  /**
   * 10-digit UTR (Unique Taxpayer Reference) for self-assessment or
   * Corporation Tax. Sole traders + Ltd both need one; HMRC issues
   * automatically after registration.
   */
  utrNumber: z.string().default(""),
  /**
   * VAT registration. UK threshold is £85k (2024) — flip to true once
   * registered (voluntarily or compulsorily).
   */
  vatRegistered: z.boolean().default(false),
  vatNumber: z.string().default(""),
  /**
   * PAYE registration — only required if the founder hires staff.
   * Manifest's `hiresStaff` flag drives whether the audit warns about
   * a missing PAYE registration.
   */
  payeRegistered: z.boolean().default(false),
});
export type HmrcSetup = z.infer<typeof HmrcSetupSchema>;

/**
 * Business banking. `appliedAt` and `activeAt` track milestones — UK
 * banks (Tide, Mettle, Starling Business, etc.) typically take a few
 * days to approve, and the canvas should reflect that timeline.
 */
export const BankingSetupSchema = z.object({
  status: z.enum(["not_started", "applied", "active"]).default("not_started"),
  /** Bank name as a free-text label (Mettle, Tide, Starling Business, etc.). */
  bankName: z.string().default(""),
  /** Account type — "business current", "business savings", etc. */
  accountType: z.string().default(""),
  appliedAt: z.string().default(""),
  activeAt: z.string().default(""),
});
export type BankingSetup = z.infer<typeof BankingSetupSchema>;

/**
 * Insurance posture. We split the common policies a software venture
 * actually needs into named booleans so the audit can flag the gaps
 * specific to the venture's flags (e.g. `handlesPersonalData` →
 * cyber insurance recommended).
 */
export const InsuranceSetupSchema = z.object({
  /** Professional indemnity — protects against client claims. */
  professional: z.boolean().default(false),
  /** Public liability — protects against third-party injury / damage. */
  publicLiability: z.boolean().default(false),
  /** Cyber — relevant when handling personal data or payments. */
  cyber: z.boolean().default(false),
  /** Employer's liability — required if hiring staff. */
  employersLiability: z.boolean().default(false),
  /** Free-text: provider, policy number, renewal date, etc. */
  notes: z.string().default(""),
});
export type InsuranceSetup = z.infer<typeof InsuranceSetupSchema>;

/**
 * IP + founder agreements. Critical for Ltd ventures — the founder
 * must assign IP they created BEFORE incorporation to the company,
 * otherwise the company doesn't legally own its own product.
 */
export const IpAssignmentSchema = z.object({
  /** Founder-to-company IP assignment doc signed and filed. */
  founderIpAssigned: z.boolean().default(false),
  /** Multi-founder agreement (vesting, decisions, exit) signed. */
  founderAgreementSigned: z.boolean().default(false),
  /**
   * Trademark applications filed (the brand stage's launchers help
   * with searches; this is the actual filing). Keyed by jurisdiction
   * for cross-reference with `trademarkStatus` in name-candidates.
   */
  trademarksFiled: z.record(z.string(), z.boolean()).default({}),
  notes: z.string().default(""),
});
export type IpAssignment = z.infer<typeof IpAssignmentSchema>;

// ---------------------------------------------------------------------------
// Top-level canvas
// ---------------------------------------------------------------------------

/**
 * The on-disk canvas at `04_uk_business/uk-setup.json`. Versioned so
 * we can evolve the schema without corrupting existing files.
 */
export const UkSetupCanvasSchema = z.object({
  ventureId: z.string(),
  /**
   * Mirror of `manifest.entityType` at canvas creation. Kept on the
   * canvas because the founder may revise the choice during UK Setup
   * (e.g. start as sole_trader, decide to incorporate as Ltd).
   * `manifest.entityType` is the "intended at venture creation"; this
   * is the "current truth as of UK Setup completion".
   */
  entityType: EntityTypeSchema,
  company: CompanyDetailsSchema.default(() => CompanyDetailsSchema.parse({})),
  hmrc: HmrcSetupSchema.default(() => HmrcSetupSchema.parse({})),
  banking: BankingSetupSchema.default(() => BankingSetupSchema.parse({})),
  insurance: InsuranceSetupSchema.default(() => InsuranceSetupSchema.parse({})),
  ipAssignment: IpAssignmentSchema.default(() => IpAssignmentSchema.parse({})),
  /** Free-text notes for anything that doesn't fit the structured fields. */
  notes: z.string().default(""),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().default(1),
});
export type UkSetupCanvas = z.infer<typeof UkSetupCanvasSchema>;

/**
 * Build a fresh canvas from a manifest. Called by the pipeline step
 * when no existing canvas is present. Defaults to the manifest's
 * entityType; everything else starts blank for the founder to fill.
 */
export function createEmptyUkSetupCanvas(
  ventureId: string,
  entityType: z.infer<typeof EntityTypeSchema>
): UkSetupCanvas {
  const now = new Date().toISOString();
  return UkSetupCanvasSchema.parse({
    ventureId,
    entityType,
    createdAt: now,
    updatedAt: now,
  });
}

// ---------------------------------------------------------------------------
// Must-haves derivation
// ---------------------------------------------------------------------------

/**
 * Whether UK Setup is "complete enough" to advance to SPEC_READY.
 * Different requirements per entity type — a sole trader has fewer
 * must-haves than an Ltd. Each rule returns whether it passes; the
 * UI panel surfaces unmet rules as the must-haves checklist.
 *
 * Returns the rules in declaration order so the UI's order matches
 * the audit's order (no double-source-of-truth).
 */
export type UkSetupRule = {
  id: string;
  label: string;
  description: string;
  pass: boolean;
};

/**
 * Compute must-haves from a canvas + the originating manifest's
 * flags. The flags drive which rules apply (a non-staff-hiring
 * venture skips the PAYE check; a non-data-handling venture skips
 * cyber insurance; etc.).
 */
export function deriveUkSetupRules(
  canvas: UkSetupCanvas,
  flags: {
    hiresStaff: boolean;
    handlesPersonalData: boolean;
    takesPayments: boolean;
  }
): UkSetupRule[] {
  const rules: UkSetupRule[] = [];

  // Entity decision is the ONLY rule that's universal across types.
  rules.push({
    id: "entity.decided",
    label: "Entity type decided",
    description: "Sole trader / Ltd / partnership chosen",
    pass: canvas.entityType !== "undecided",
  });

  if (canvas.entityType === "ltd") {
    rules.push({
      id: "company.name",
      label: "Company name set",
      description: "Companies House preferred name",
      pass: canvas.company.name.trim().length > 0,
    });
    rules.push({
      id: "company.sic",
      label: "SIC code chosen",
      description: "At least one SIC code for Companies House",
      pass: canvas.company.sicCode.trim().length > 0,
    });
    rules.push({
      id: "company.address",
      label: "Registered office set",
      description: "Address line 1 + postcode required",
      pass:
        canvas.company.registeredOffice.line1.trim().length > 0 &&
        canvas.company.registeredOffice.postcode.trim().length > 0,
    });
    rules.push({
      id: "ip.assigned",
      label: "Founder IP assigned",
      description: "IP assignment doc signed (Ltd-only)",
      pass: canvas.ipAssignment.founderIpAssigned,
    });
  }

  // HMRC UTR is universal — sole trader and Ltd both get one.
  rules.push({
    id: "hmrc.utr",
    label: "HMRC UTR recorded",
    description: "10-digit Unique Taxpayer Reference",
    pass: canvas.hmrc.utrNumber.trim().length > 0,
  });

  // PAYE only when hiring.
  if (flags.hiresStaff) {
    rules.push({
      id: "hmrc.paye",
      label: "PAYE registered",
      description: "Required when hiring staff",
      pass: canvas.hmrc.payeRegistered,
    });
    rules.push({
      id: "insurance.employers",
      label: "Employer's liability insurance",
      description: "Legally required when hiring staff",
      pass: canvas.insurance.employersLiability,
    });
  }

  // Banking — every venture needs an account; even sole traders
  // benefit from separating personal and business cashflow.
  rules.push({
    id: "banking.active",
    label: "Business bank account active",
    description: "Account approved and in use",
    pass: canvas.banking.status === "active",
  });

  // Insurance — professional indemnity is the universal recommendation
  // for software ventures.
  rules.push({
    id: "insurance.professional",
    label: "Professional indemnity insurance",
    description: "Standard for software / consulting ventures",
    pass: canvas.insurance.professional,
  });

  // Cyber insurance recommended when handling personal data or
  // taking payments (overlap with the GDPR + PCI risk surface).
  if (flags.handlesPersonalData || flags.takesPayments) {
    rules.push({
      id: "insurance.cyber",
      label: "Cyber insurance",
      description: "Recommended for personal-data / payments ventures",
      pass: canvas.insurance.cyber,
    });
  }

  return rules;
}

/**
 * Convenience — true when every applicable rule passes. The UI uses
 * this to gate the "Advance to Spec" button.
 */
export function isUkSetupComplete(
  canvas: UkSetupCanvas,
  flags: Parameters<typeof deriveUkSetupRules>[1]
): boolean {
  return deriveUkSetupRules(canvas, flags).every((r) => r.pass);
}
