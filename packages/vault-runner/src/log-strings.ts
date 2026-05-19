/**
 * Slice 8 -- drift-protected log strings for the Dream Vault runner.
 *
 * The desktop adoption helpers parse `result.logs[].message` to derive
 * UI-friendly per-step status. If a runner silently changes the strings
 * it emits, the helpers downgrade gracefully (toast counts go to zero)
 * without any compile-time signal. The `log-strings.test.ts` file in
 * this package is the safety net.
 *
 * Order matches DREAM-VAULT-MODULE-SPEC.md §3 slice 8 phases:
 *   1. Copying files to import cache
 *   2. Detecting file types
 *   3. Extracting text
 *   4. Analysing images
 *   5. Parsing chats
 *   6. Classifying projects
 *   7. Extracting knowledge
 *   8. Generating draft vault notes
 *   9. Ready for review
 *
 * The first three phases are confirmation-only: processImportJob in
 * import-core has already staged the files and detected types before
 * the runner is invoked. Phases 3-8 do the work. Phase 9 is the gate.
 *
 * Two extra strings cover finalize() (the post-review commit method):
 *   - "Vault notes written"
 *   - "Vault import committed"
 */
export const VAULT_LOG_STRINGS = {
  starting: "Vault import starting",
  copying: "Copying files to import cache",
  detecting: "Detecting file types",
  extractingText: "Extracting text",
  analysingImages: "Analysing images",
  parsingChats: "Parsing chats",
  classifying: "Classifying projects",
  extractingKnowledge: "Extracting knowledge",
  generatingDrafts: "Generating draft vault notes",
  readyForReview: "Ready for review",
  finalising: "Vault import finalising",
  notesWritten: "Vault notes written",
  committed: "Vault import committed",
  // Per-source diagnostics (countable):
  sourceFailed: "Vault source failed",
  sourceSkipped: "Vault source skipped",
} as const;

export type VaultLogKey = keyof typeof VAULT_LOG_STRINGS;
