/**
 * Pipeline-hardening smoke tests (2026-05-18).
 *
 * Cross-package regression tests for the pipeline-hardening pass.
 * The per-package logic lives in artifacts-index, artifacts-core, and
 * domain; this file pulls them together so a regression in any of
 * them surfaces in the stage-runners suite (which is already wired
 * into the user's commit/CI workflow).
 *
 * Coverage:
 *   1. ArtifactType enum gained the pipeline-hardening additions.
 *   2. inferArtifactType maps the new conventions to the new types
 *      (regression test for fix #7 -- before this pass, the scanner
 *      mis-tagged backend/media/crm/handoff-pack files as
 *      "research-summary").
 *   3. UK_LEGAL_CONSTANTS holds the current GOV.UK VAT thresholds
 *      (£90,000 registration / £88,000 deregistration since
 *      2024-04-01). Regression test for fix #6.
 */
import { describe, expect, it } from "vitest";
import { ArtifactTypeSchema } from "@founder-os/artifacts-core";
import { inferArtifactType } from "@founder-os/artifacts-index";
import { UK_LEGAL_CONSTANTS } from "@founder-os/domain";

describe("ArtifactType enum (fix #7)", () => {
  const required = [
    "validation-summary",
    "finance-plan",
    "handoff-export",
    "media-script",
    "storyboard",
    "render-shot",
    "launch-reel",
    "media-checkpoint",
    "media-edit-receipt",
    "crm-instance",
    "crm-config",
    "crm-campaign",
    "crm-template",
    "backend-export",
    "backend-checkpoint",
    "handoff-pack-pdf",
    "handoff-pack-inventory",
    "launch-receipt",
    "launch-announcement",
    "social-post",
  ];

  it("contains every pipeline-hardening type", () => {
    const enumValues = new Set(ArtifactTypeSchema.options);
    for (const t of required) {
      expect(enumValues.has(t), `missing ArtifactType "${t}"`).toBe(true);
    }
  });
});

describe("inferArtifactType (fix #7)", () => {
  function file(relativePath: string, ext: string) {
    return {
      absolutePath: `/v/${relativePath}`,
      relativePath,
      filename: relativePath.split("/").pop() ?? relativePath,
      ext,
      sizeBytes: 0,
      sha256: "x",
      modifiedAt: new Date().toISOString(),
    };
  }

  it("classifies 12_backend/backend-export.json as backend-export", () => {
    expect(inferArtifactType(file("12_backend/backend-export.json", ".json"))).toBe(
      "backend-export",
    );
  });

  it("classifies 12_backend/backend-checkpoint.json as backend-checkpoint", () => {
    expect(inferArtifactType(file("12_backend/backend-checkpoint.json", ".json"))).toBe(
      "backend-checkpoint",
    );
  });

  it("classifies 11_crm/crm-instance.json as crm-instance", () => {
    expect(inferArtifactType(file("11_crm/crm-instance.json", ".json"))).toBe("crm-instance");
  });

  it("classifies 11_crm/campaigns/launch-campaign.json as crm-campaign", () => {
    expect(inferArtifactType(file("11_crm/campaigns/launch-campaign.json", ".json"))).toBe(
      "crm-campaign",
    );
  });

  it("classifies 11_crm/templates/email-welcome.md as crm-template", () => {
    expect(inferArtifactType(file("11_crm/templates/email-welcome.md", ".md"))).toBe(
      "crm-template",
    );
  });

  it("classifies 10_media/media-checkpoint.json as media-checkpoint", () => {
    expect(inferArtifactType(file("10_media/media-checkpoint.json", ".json"))).toBe(
      "media-checkpoint",
    );
  });

  it("classifies 10_media/scripts/foo.json as media-script", () => {
    expect(inferArtifactType(file("10_media/scripts/foo.json", ".json"))).toBe("media-script");
  });

  it("classifies 10_media/storyboards/foo.json as storyboard", () => {
    expect(inferArtifactType(file("10_media/storyboards/foo.json", ".json"))).toBe("storyboard");
  });

  it("classifies 10_media/renders/clip-01.mp4 as render-shot", () => {
    expect(inferArtifactType(file("10_media/renders/clip-01.mp4", ".mp4"))).toBe("render-shot");
  });

  it("classifies 10_media/exports/launch-reel.mp4 as launch-reel", () => {
    expect(inferArtifactType(file("10_media/exports/launch-reel.mp4", ".mp4"))).toBe(
      "launch-reel",
    );
  });

  it("classifies 13_handoff_pack/01-overview/cover.pdf as handoff-pack-pdf", () => {
    expect(inferArtifactType(file("13_handoff_pack/01-overview/cover.pdf", ".pdf"))).toBe(
      "handoff-pack-pdf",
    );
  });

  it("classifies 13_handoff_pack/inventory.md as handoff-pack-inventory", () => {
    expect(inferArtifactType(file("13_handoff_pack/inventory.md", ".md"))).toBe(
      "handoff-pack-inventory",
    );
  });

  it("classifies 08_launch/launch-receipt.json as launch-receipt", () => {
    expect(inferArtifactType(file("08_launch/launch-receipt.json", ".json"))).toBe(
      "launch-receipt",
    );
  });

  it("classifies 08_launch/launch-announcement.md as launch-announcement", () => {
    expect(inferArtifactType(file("08_launch/launch-announcement.md", ".md"))).toBe(
      "launch-announcement",
    );
  });

  it("classifies 02_validation/validation-summary.json as validation-summary (not research-summary)", () => {
    expect(inferArtifactType(file("02_validation/validation-summary.json", ".json"))).toBe(
      "validation-summary",
    );
  });

  it("classifies 05_finance/finance-plan.json as finance-plan", () => {
    expect(inferArtifactType(file("05_finance/finance-plan.json", ".json"))).toBe("finance-plan");
  });

  it("classifies 06_product/wireframes/handoff-export.json as handoff-export", () => {
    expect(inferArtifactType(file("06_product/wireframes/handoff-export.json", ".json"))).toBe(
      "handoff-export",
    );
  });
});

describe("UK_LEGAL_CONSTANTS (fix #6)", () => {
  it("VAT registration threshold is £90,000 (raised 2024-04-01)", () => {
    expect(UK_LEGAL_CONSTANTS.vat.registrationThresholdGBP).toBe(90_000);
  });

  it("VAT deregistration threshold is £88,000", () => {
    expect(UK_LEGAL_CONSTANTS.vat.deregistrationThresholdGBP).toBe(88_000);
  });

  it("VAT thresholds effectiveFrom is 2024-04-01", () => {
    expect(UK_LEGAL_CONSTANTS.vat.effectiveFrom).toBe("2024-04-01");
  });

  it("Corporation tax small profits upper bound is £50,000", () => {
    expect(UK_LEGAL_CONSTANTS.corporationTax.smallProfitsRateUpperBoundGBP).toBe(50_000);
  });

  it("Corporation tax main rate threshold is £250,000", () => {
    expect(UK_LEGAL_CONSTANTS.corporationTax.mainRateThresholdGBP).toBe(250_000);
  });
});
