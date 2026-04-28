/**
 * scripts/seed.ts
 * ────────────────
 * Creates a demo venture and runs the full pipeline end-to-end.
 * Run AFTER pnpm install:
 *   npx tsx --tsconfig tsconfig.seed.json scripts/seed.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const DEMO_VENTURE_ROOT = path.join(os.tmpdir(), "founder-os-demo-venture");

const VENTURE_MANIFEST = {
  id: "demo-001",
  name: "TaskFlow",
  slug: "taskflow",
  entityType: "ltd" as const,
  industry: "Productivity Software",
  appType: "saas" as const,
  regulated: false,
  takesPayments: true,
  handlesPersonalData: true,
  hiresStaff: false,
  monthlyBudgetCapGBP: 500,
  currentStage: "IDEA" as const,
  blockers: [],
};

async function main() {
  console.log("\n🚀 Founder OS — Seed Script");
  console.log("═".repeat(50));
  console.log(`Demo venture root: ${DEMO_VENTURE_ROOT}\n`);

  // ── 1. Scaffold dirs ──────────────────────────────
  step("1. Scaffolding venture directory");
  scaffoldDirectories(DEMO_VENTURE_ROOT);

  // ── 2. Manifest ───────────────────────────────────
  step("2. Writing venture manifest");
  const manifestPath = path.join(DEMO_VENTURE_ROOT, "venture.yaml");
  fs.writeFileSync(
    manifestPath,
    [
      "# Founder OS Venture Manifest",
      `id: ${VENTURE_MANIFEST.id}`,
      `name: ${VENTURE_MANIFEST.name}`,
      `slug: ${VENTURE_MANIFEST.slug}`,
      `entityType: ${VENTURE_MANIFEST.entityType}`,
      `industry: ${VENTURE_MANIFEST.industry}`,
      `appType: ${VENTURE_MANIFEST.appType}`,
      `regulated: ${VENTURE_MANIFEST.regulated}`,
      `takesPayments: ${VENTURE_MANIFEST.takesPayments}`,
      `handlesPersonalData: ${VENTURE_MANIFEST.handlesPersonalData}`,
      `hiresStaff: ${VENTURE_MANIFEST.hiresStaff}`,
      `monthlyBudgetCapGBP: ${VENTURE_MANIFEST.monthlyBudgetCapGBP}`,
      `currentStage: ${VENTURE_MANIFEST.currentStage}`,
      "blockers: []",
    ].join("\n") + "\n",
    "utf-8"
  );
  ok(`Written: ${manifestPath}`);

  // ── 3. Pipeline ───────────────────────────────────
  step("3. Running pipeline");

  // Import directly from source — tsx resolves .ts files
  const runnerPath = pathToFileURL(
    path.join(ROOT, "packages", "pipeline-runner", "src", "index.ts")
  ).href;

  let runPipeline:
    | ((opts: unknown) => Promise<{
        success: boolean;
        error?: string;
        plan: { steps: Array<{ name: string; status: string }> };
      }>)
    | null = null;

  try {
    const mod = await import(runnerPath);
    runPipeline = mod.runPipeline;
  } catch (err) {
    console.log(`\n⚠️  Could not load pipeline-runner: ${(err as Error).message}`);
    console.log("   Running in simulation mode.\n");
  }

  if (runPipeline) {
    try {
      const result = await runPipeline({
        manifest: VENTURE_MANIFEST,
        ventureRoot: DEMO_VENTURE_ROOT,
        onProgress: (plan: { steps: Array<{ status: string; name: string }> }) => {
          const active = plan.steps.find((s: { status: string }) => s.status === "running");
          if (active) process.stdout.write(`  ⏳ ${active.name}…\r`);
        },
      });

      console.log("\n");
      for (const s of result.plan.steps) {
        const icon = s.status === "done" ? "✅" : s.status === "skipped" ? "⏭️" : "❌";
        console.log(`  ${icon} ${s.name}`);
      }

      if (!result.success) {
        fail(`Pipeline failed: ${result.error}`);
        process.exit(1);
      }
      ok("Pipeline complete!");
    } catch (err) {
      fail(`Pipeline threw: ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    // Simulation mode
    for (const name of [
      "Ensure Dev Brief",
      "Ensure Product Spec",
      "Create Brand Brief",
      "Create Logo Pack",
      "Create Stitch Pack",
      "Create Build Handoff",
    ]) {
      console.log(`  ✅ ${name} [simulated]`);
    }
  }

  // ── 4. Verify files ───────────────────────────────
  step("4. Verifying output files");
  const expected = [
    "venture.yaml",
    "06_product/brief/dev-brief.md",
    "06_product/specs/product-spec.md",
    "03_brand/brand-kit/brand-brief.json",
    "03_brand/logo/exports/logo.svg",
    "03_brand/logo/exports/logo-dark.svg",
    "03_brand/logo/exports/logo-icon.svg",
    "03_brand/logo/exports/tokens.json",
    "03_brand/logo/exports/tailwind-preset.js",
    "06_product/stitch/stitch-prompt.md",
    "06_product/stitch/stitch-config.json",
  ];

  let passed = 0;
  for (const f of expected) {
    const fp = path.join(DEMO_VENTURE_ROOT, f);
    if (fs.existsSync(fp)) {
      ok(`  ✓ ${f}`);
      passed++;
    } else {
      warn(`  ✗ MISSING: ${f}`);
    }
  }
  console.log(`\n${passed}/${expected.length} files verified`);

  // ── 5. Handoff bundle check ───────────────────────
  step("5. Checking handoff bundle");
  const inboxDir = path.join(DEMO_VENTURE_ROOT, ".founder", "handoffs", "inbox");
  if (fs.existsSync(inboxDir)) {
    const bundles = fs.readdirSync(inboxDir).filter((f) => f.endsWith(".json"));
    if (bundles.length > 0) {
      ok(`Handoff bundle ready: ${bundles[0]}`);
      const bundle = JSON.parse(fs.readFileSync(path.join(inboxDir, bundles[0]), "utf-8"));
      console.log(`  runId: ${bundle.runId}`);
      console.log(`  type:  ${bundle.type}`);
    } else {
      warn("No bundle yet — pipeline ran in simulation mode");
    }
  }

  // ── 6. Summary ────────────────────────────────────
  console.log("\n" + "═".repeat(50));
  console.log(
    passed === expected.length
      ? "🎉 Full pipeline verified!"
      : "⚠️  Partial run — see missing files above"
  );
  console.log(`\nDemo venture: ${DEMO_VENTURE_ROOT}`);
  if (passed < expected.length) {
    console.log("\n💡 Tip: Make sure you ran `pnpm rebuild` after `pnpm install`");
    console.log("   Then run: npx tsx --tsconfig tsconfig.seed.json scripts/seed.ts");
  } else {
    console.log("\nNext steps:");
    console.log("  pnpm desktop:tauri   — launch the desktop app");
    console.log("  pnpm extension:build — build the VS Code extension");
  }
  console.log();
}

// ── Helpers ───────────────────────────────────────────

function scaffoldDirectories(root: string) {
  const dirs = [
    "00_inbox",
    "01_research/market-gaps",
    "01_research/competitors",
    "02_validation/icp",
    "03_brand/names",
    "03_brand/logo/exports",
    "03_brand/brand-kit",
    "04_uk_business/incorporation",
    "05_finance/startup-budget",
    "06_product/brief",
    "06_product/specs",
    "06_product/stitch",
    "06_product/wireframes",
    "07_build/src",
    "07_build/audits",
    "08_launch",
    "09_operate",
    ".founder/handoffs/inbox",
    ".founder/handoffs/outbox",
    ".founder/handoffs/progress",
    ".founder/state",
    ".founder/logs",
  ];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  ok(`Scaffolded ${dirs.length} directories`);
}

function step(msg: string) {
  console.log(`\n📌 ${msg}`);
}
function ok(msg: string) {
  console.log(`✅ ${msg}`);
}
function warn(msg: string) {
  console.log(`⚠️  ${msg}`);
}
function fail(msg: string) {
  console.log(`❌ ${msg}`);
}

main().catch((err) => {
  console.error("\n❌ Seed failed:", err);
  process.exit(1);
});
