// @founder-os/handoff-pack-core/role-packs -- the 8 default role-pack
// descriptors. Each pack bundles a curated, ordered subset of DOC_MANIFEST
// entries plus a per-role cover page intro.
//
// The doc-ID lists below mirror sec 7 of HANDOFF-PACK-MODULE-SPEC.md.
// Authored alongside the manifest in slice 1 so the manifest <-> role-pack
// referential integrity is testable from day one: every docId referenced
// here MUST exist in DOC_MANIFEST (slice 2's test suite asserts this).

import type { RolePackDescriptor } from "./index.js";

export const FOUNDER_PACK: RolePackDescriptor = {
  role: "founder",
  title: "Founder Onboarding Pack",
  introText:
    "Everything you need to operate this company day-to-day. Read in order. Sections marked TODO need your input before they become useful.",
  docIds: [
    "company-brief",
    "founder-vision",
    "company-register",
    "cap-table",
    "board-decision-log",
    "strategic-roadmap",
    "okrs-kpis",
    "financial-model",
    "risk-register",
  ],
};

export const DEV_PACK: RolePackDescriptor = {
  role: "dev",
  title: "Developer Onboarding Pack",
  introText:
    "Everything required to ship safely. Start with the Developer Brief and Tech Spec; the rest is reference. Coding Standards, Git Workflow, and Secure Development Policy must be read before your first PR.",
  docIds: [
    "company-brief",
    "developer-brief",
    "prd",
    "technical-specification",
    "architecture-diagram",
    "api-specification",
    "database-schema",
    "environment-setup-guide",
    "coding-standards",
    "git-workflow",
    "testing-strategy",
    "deployment-guide",
    "secure-development-policy",
    "ai-dev-policy",
  ],
};

export const DESIGNER_PACK: RolePackDescriptor = {
  role: "designer",
  title: "Designer Onboarding Pack",
  introText:
    "Brand, product, and user context for design work. Start with Product Vision and Personas; the Design System is the source of truth for tokens and components.",
  docIds: [
    "company-brief",
    "product-vision",
    "icp-personas",
    "user-journey-maps",
    "wireframe-pack",
    "brand-guide",
    "design-system",
    "accessibility-checklist",
    "copy-microcopy-guide",
  ],
};

export const MARKETING_PACK: RolePackDescriptor = {
  role: "marketing",
  title: "Marketing Onboarding Pack",
  introText:
    "Context for how this company talks about itself. The Brand Messaging Guide and Website Copy are authoritative; ad and content work should align to them.",
  docIds: [
    "company-brief",
    "market-research",
    "competitor-analysis",
    "brand-messaging-guide",
    "website-copy",
    "seo-strategy",
    "content-calendar",
    "launch-plan",
    "social-media-strategy",
  ],
};

export const SALES_PACK: RolePackDescriptor = {
  role: "sales",
  title: "Sales Onboarding Pack",
  introText:
    "The ICP, pricing, and process. The Sales Playbook is the source of truth for stages and required fields; everything else supports it.",
  docIds: [
    "icp-personas",
    "buyer-personas",
    "pricing-sheet",
    "sales-playbook",
    "demo-script",
    "objection-handling",
    "crm-process",
    "proposal-template",
  ],
};

export const SUPPORT_PACK: RolePackDescriptor = {
  role: "support",
  title: "Support Onboarding Pack",
  introText:
    "Customer-facing guides plus the internal SOPs that keep responses consistent. Customer Data Handling SOP must be read before you access any customer record.",
  docIds: [
    "company-brief",
    "faq",
    "support-playbook",
    "escalation-policy",
    "bug-report-template",
    "customer-data-handling-sop",
    "cancellation-flow",
  ],
};

export const FINANCE_PACK: RolePackDescriptor = {
  role: "finance",
  title: "Finance and Admin Onboarding Pack",
  introText:
    "The company's commercial backbone. Cap Table and Company Register are the legal source of truth; Financial Model and Subscription Cost Register are the live operating documents.",
  docIds: [
    "company-register",
    "cap-table",
    "startup-budget",
    "financial-model",
    "subscription-cost-register",
    "payroll-process",
    "tax-calendar",
    "invoice-template",
    "purchase-order-process",
  ],
};

export const CONTRACTOR_PACK: RolePackDescriptor = {
  role: "contractor",
  title: "Contractor Onboarding Pack",
  introText:
    "Commercial terms, IP boundaries, and the security expectations that come with access to company systems. The Contractor Agreement and IP Assignment must be signed before work begins.",
  docIds: [
    "company-brief",
    "contractor-agreement",
    "nda",
    "ip-assignment-agreement",
    "code-of-conduct",
    "communication-policy",
    "ai-dev-policy",
    "secure-development-policy",
    "onboarding-checklist",
  ],
};

/**
 * Ordered array of all 8 default role packs. The HandoffPackStageRunner
 * iterates this in order; the desktop UI renders one button per entry.
 */
export const DEFAULT_ROLE_PACKS: ReadonlyArray<RolePackDescriptor> = [
  FOUNDER_PACK,
  DEV_PACK,
  DESIGNER_PACK,
  MARKETING_PACK,
  SALES_PACK,
  SUPPORT_PACK,
  FINANCE_PACK,
  CONTRACTOR_PACK,
];

/**
 * Look up a role-pack descriptor by role; undefined if the role isn't in
 * the default set (shouldn't happen -- the Role enum is exhaustive and
 * every member has a default pack).
 */
export function getRolePackByRole(
  role: RolePackDescriptor["role"]
): RolePackDescriptor | undefined {
  return DEFAULT_ROLE_PACKS.find((p) => p.role === role);
}
