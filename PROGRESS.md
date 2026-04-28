# Founder OS — Build Progress

Status: **BUILD COMPLETE** ✅ — all 22 packages + 2 apps implemented. 140 files total.

## ✅ All Done

### Root config
- `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `biome.json`

### Packages — all 22 implemented

| Package | Status | Key exports |
|---------|--------|-------------|
| `@founder-os/domain` | ✅ | VentureStage, VentureManifest, Task, ArtifactRef (all Zod) |
| `@founder-os/logger` | ✅ | createLogger, log, redact |
| `@founder-os/artifacts-core` | ✅ | 20 artifact types, createArtifact, computeArtifactId |
| `@founder-os/audit-contract` | ✅ | AuditFinding, AuditSummary, countBySeverity |
| `@founder-os/handoff-contract` | ✅ | HandoffBundle, HandoffResult, parseBundle, generateRunId |
| `@founder-os/workspace-core` | ✅ | path helpers, ventureHandoffPaths, ventureArtifactDirs |
| `@founder-os/workspace-node` | ✅ | fs adapter, scaffoldVentureDirs, watchJsonDir |
| `@founder-os/workspace-tauri` | ✅ | Tauri v2 plugin-fs adapter |
| `@founder-os/db` | ✅ | Drizzle schema, migrations, all 4 repos |
| `@founder-os/pipeline-core` | ✅ | stage machine, RunPlan, evaluateStageCompletion |
| `@founder-os/pipeline-runner` | ✅ | runPipeline orchestrator, 6 steps |
| `@founder-os/branding-core` | ✅ | BrandBrief (Zod), NamingReport, generateSeedCandidates |
| `@founder-os/branding-assets` | ✅ | materializeBrandPack — SVG logos, tokens.json, Tailwind preset |
| `@founder-os/artifacts-index` | ✅ | scanVentureArtifacts, syncArtifactsToDb |
| `@founder-os/handoff-desktop` | ✅ | createBundle, writeInbox, watchOutbox, ingestResult |
| `@founder-os/handoff-vscode` | ✅ | watchInbox, acceptBundle, writeResult, makeSuccessResult |
| `@founder-os/prompts` | ✅ | system prompts, STAGE_FIRST_MESSAGE, templates |
| `@founder-os/state` | ✅ | Zustand: ventureStore, pipelineStore, handoffStore |
| `@founder-os/query` | ✅ | TanStack Query hooks, queryKeys, FounderQueryProvider |
| `@founder-os/ui` | ✅ | AppShell, Sidebar, Button, Card, StageBadge |
| `@founder-os/chat-ui` | ✅ | ProjectChat component |
| `@founder-os/graph-ui` | ✅ | StageGraph (React Flow) |
| `@founder-os/llm-providers` | ✅ | 8-provider catalog + types: Anthropic, OpenAI, Gemini, DeepSeek, Grok, Kimi, Perplexity, Ollama |

### Apps

| App | Status | Notes |
|-----|--------|-------|
| `apps/founder-desktop` | ✅ | Vite+React 19+Tauri v2, App.tsx, VentureDashboard, all tabs |
| `apps/builder-extension` | ✅ | VS Code extension, inbox watcher, BuildRunner (streams Claude API), StatusTree |

### Scripts
- `scripts/seed.ts` — creates demo venture, runs pipeline, verifies output files. Runs clean.

## 🚀 How to run

```bash
# 1. Install dependencies
pnpm install

# 2. Run the seed (end-to-end acceptance test)
npx tsx scripts/seed.ts

# 3. Launch the desktop app
pnpm desktop:tauri

# 4. Build the VS Code extension
pnpm extension:build
```

## Architecture decisions (locked in)
- **Tauri v2** (not v1)
- **Drizzle ORM** on better-sqlite3 (typed inline migrations)
- **Zod** on every boundary — handoff-contract, audit-contract, artifacts-core, domain
- **Biome** (not ESLint+Prettier) — one tool, one config
- **React 19 + Vite** for desktop frontend
- **chokidar/fs.watch** for file watching
- **@xyflow/react** for graph-ui (stage pipeline graph)
- **Handoff flow is file-based** (not socket-based) — survives restarts, auditable
- **Claude Opus 4** streams code generation in the VS Code extension
