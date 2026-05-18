import { describe, expect, it } from "vitest";
import type { VentureManifest } from "@founder-os/domain";
import type { Filesystem } from "@founder-os/pipeline-runner";
import { runStageRunnersCli } from "../src/cli.js";
import { makeManifest } from "./_helpers/manifest.js";

class SmokeRunner {
  constructor(readonly opts: { ventureRoot: string; manifest: VentureManifest; fs: Filesystem }) {}

  async run() {
    return {
      success: true,
      stageName: "HANDOFF_PACK" as const,
      runId: "run-smoke",
      artifactsCreated: [
        `${this.opts.ventureRoot}/13_handoff_pack/INDEX.md`,
        `${this.opts.ventureRoot}/13_handoff_pack/handoff-pack-inventory.json`,
        `${this.opts.ventureRoot}/13_handoff_pack/role-packs/founder-pack.pdf`,
        `${this.opts.ventureRoot}/13_handoff_pack/company-control/one.pdf`,
      ],
      logs: [],
      requiresReview: false,
      nextStageReady: true,
    };
  }
}

const fsStub: Filesystem = {
  async mkdir() {},
  async exists() {
    return true;
  },
  async readFile() {
    return "";
  },
  async writeFile() {},
};

describe("stage-runners CLI -- handoff pack smoke", () => {
  it("returns a usage envelope for unknown commands", async () => {
    const out = await runStageRunnersCli(["node", "cli", "wat"]);
    expect(out.exitCode).toBe(1);
    expect(out.envelope).toEqual({
      error: "usage: stage-runners handoff-pack-run-stage --venture-root <abs> --manifest <abs>",
    });
  });

  it("returns an error envelope when required args are missing", async () => {
    const out = await runStageRunnersCli(["node", "cli", "handoff-pack-run-stage"]);
    expect(out.exitCode).toBe(1);
    expect(out.envelope).toEqual({ error: "--venture-root is required" });
  });

  it("returns the sidecar JSON envelope shape expected by Tauri", async () => {
    const manifest = makeManifest();
    const ventureRoot = "/venture";
    const checkpointPath = `${ventureRoot}/13_handoff_pack/handoff-pack-checkpoint.json`;
    const out = await runStageRunnersCli(
      [
        "node",
        "cli",
        "handoff-pack-run-stage",
        "--venture-root",
        ventureRoot,
        "--manifest",
        "/venture/.founder/manifest-snapshot.json",
      ],
      {
        existsSync: () => true,
        readFileSync: (path) =>
          path === checkpointPath
            ? JSON.stringify({
                docsRendered: 2,
                docsPartial: 1,
                docsStubbed: 3,
                docsFailed: 5,
                rolePacksGenerated: 1,
                inventoryPath: "/venture/13_handoff_pack/INDEX.md",
              })
            : `\uFEFF${JSON.stringify(manifest)}`,
        fs: fsStub,
        Runner: SmokeRunner as never,
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.envelope).toMatchObject({
      counts: { docsRendered: 6, rolePacksGenerated: 1, failed: 5 },
      steps: { brand: "ok", docs: "ok", rolePacks: "ok", inventory: "ok" },
      checkpointPath: "/venture/13_handoff_pack/handoff-pack-checkpoint.json",
    });
  });
});
