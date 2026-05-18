// @founder-os/handoff-pack-templates -- on-disk markdown template tree
// for the HANDOFF_PACK stage. This module exports filesystem-agnostic
// metadata (paths + ids) so slice 5's runner can resolve template paths
// without booting a Node-only loader.
//
// Actual template bodies are read from disk by the Node side of
// @founder-os/handoff-pack-providers; this barrel deliberately does
// NOT inline them as string literals (would balloon the renderer
// bundle from ~50KB to ~600KB).

import { DOC_MANIFEST } from "@founder-os/handoff-pack-core/manifest";

/**
 * Workspace-relative path to the on-disk template root. Resolved by
 * the Node consumer via `path.join(workspaceRoot, TEMPLATES_DIR)` so
 * the renderer can locate a template by descriptor.
 */
export const TEMPLATES_DIR = "packages/handoff-pack-templates/templates";

/**
 * Build a templatePath -> docId index from the manifest. Used by the
 * smoke test to assert every on-disk file corresponds to a manifest
 * entry and vice-versa.
 */
export function buildDocIdByTemplatePath(): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const entry of DOC_MANIFEST) {
    map.set(entry.templatePath, entry.id);
  }
  return map;
}

/**
 * Frontmatter shape every template's YAML block conforms to. The
 * smoke test parses this off the top of each file and cross-checks
 * against the manifest.
 */
export type TemplateFrontmatter = {
  docId: string;
  tier: "A" | "B" | "C" | "D";
  category: string;
};
