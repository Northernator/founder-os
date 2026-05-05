/**
 * Minimal VentureManifest factory for tests. The schema requires
 * lots of fields; this builder fills sensible defaults so tests can
 * override only what they care about.
 */
import type { VentureManifest } from "@founder-os/domain";

export function makeManifest(overrides: Partial<VentureManifest> = {}): VentureManifest {
  return {
    id: "test-venture",
    name: "Test Venture",
    slug: "test",
    entityType: "ltd",
    appType: "saas",
    regulated: false,
    takesPayments: false,
    handlesPersonalData: false,
    hiresStaff: false,
    currentStage: "RESEARCHED",
    blockers: [],
    ...overrides,
  };
}
