/**
 * Slice 7 -- engineering Tier-B step tests (pure renders).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createArchitectureDiagramStep,
  createEnvironmentSetupGuideStep,
  type GoldenStepContext,
} from "../../src/node/tier-b/index.js";
import type { BrandTokens } from "@founder-os/handoff-pack-core";

const TOKENS: BrandTokens = {
  logoSvgPath: ".brand/logo.svg",
  logoPngPath: ".brand/logo.png",
  companyName: "Acme Inc",
  colors: { primary: "#1F2937", secondary: "#6B7280", background: "#FFFFFF", text: "#111827" },
  fonts: { heading: "Inter", body: "Inter", mono: "JetBrains Mono" },
  extractedAt: "2026-05-17T00:00:00.000Z",
};
const NOW = () => new Date("2026-05-17T12:00:00.000Z");

let ventureRoot: string;

beforeEach(async () => {
  ventureRoot = await mkdtemp(join(tmpdir(), "tierb-eng-"));
});

afterEach(async () => {
  if (ventureRoot && existsSync(ventureRoot)) {
    await rm(ventureRoot, { recursive: true, force: true });
  }
});

function ctx(extra: Partial<GoldenStepContext> = {}): GoldenStepContext {
  return {
    ventureRoot,
    ventureName: "Acme Inc",
    ventureSlug: "acme",
    brandTokens: TOKENS,
    now: NOW,
    ...extra,
  };
}

describe("createArchitectureDiagramStep", () => {
  it("renders a specialised Mermaid block from backend-export.json", async () => {
    const dir = join(ventureRoot, "12_backend");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "backend-export.json"),
      JSON.stringify({
        framework: "Hono",
        database: "SQLite",
        auth: { provider: "Lucia" },
        collections: [{ name: "users" }, { name: "ventures" }, { name: "logs" }],
      }),
      "utf-8"
    );
    const r = await createArchitectureDiagramStep(ctx());
    expect(r.placeholders.DIAGRAM_MERMAID).toContain("flowchart LR");
    expect(r.placeholders.DIAGRAM_MERMAID).toContain("Hono");
    expect(r.placeholders.DIAGRAM_MERMAID).toContain("SQLite");
    expect(r.placeholders.DIAGRAM_MERMAID).toContain("Lucia");
    expect(r.placeholders.DIAGRAM_MERMAID).toContain("3 collections");
  });

  it("falls back to a placeholder Mermaid block with a TODO callout", async () => {
    const r = await createArchitectureDiagramStep(ctx());
    expect(r.placeholders.DIAGRAM_MERMAID).toContain("flowchart LR");
    expect(r.placeholders.DIAGRAM_MERMAID).toMatch(/TODO/);
  });
});

describe("createEnvironmentSetupGuideStep", () => {
  it("extracts setup commands from 07_build/README.md when present", async () => {
    const dir = join(ventureRoot, "07_build");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "README.md"),
      "# project\n\n## Setup\n\n```bash\ngit clone git@github.com/acme/x.git\ncd x\npnpm install\npnpm dev\n```\n",
      "utf-8"
    );
    const r = await createEnvironmentSetupGuideStep(ctx());
    expect(r.placeholders.STEPS).toContain("pnpm install");
    expect(r.placeholders.STEPS).toContain("git clone");
    expect(r.sourcesRead).toContain("07_build/README.md");
  });
});
