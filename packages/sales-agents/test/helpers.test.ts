/**
 * Pure helper tests.
 *
 * slugForUrl is the only public helper from the package's main barrel
 * that has interesting edge-case behavior. Used by both single-prospect
 * and batch modes to derive output directory names from URLs.
 */
import { describe, expect, it } from "vitest";

import { slugForUrl } from "../src/pipeline.js";

describe("slugForUrl", () => {
  it("strips protocol + www + path", () => {
    expect(slugForUrl("https://www.acme.com/products")).toBe("acme-com");
  });

  it("handles bare domain", () => {
    expect(slugForUrl("https://acme.com")).toBe("acme-com");
  });

  it("collapses dots + special chars to hyphens", () => {
    expect(slugForUrl("https://api.staging.acme.io")).toBe("api-staging-acme-io");
  });

  it("lowercases", () => {
    expect(slugForUrl("https://ACME.COM")).toBe("acme-com");
  });

  it("falls back gracefully on non-URL input", () => {
    const out = slugForUrl("just-a-string");
    expect(out).toBe("just-a-string");
  });

  it("truncates long fallback to 64 chars", () => {
    const long = "a".repeat(200);
    expect(slugForUrl(long).length).toBeLessThanOrEqual(64);
  });
});
