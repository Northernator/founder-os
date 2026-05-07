// HyperFrames provider unit tests.
//
// Strategy: mock node:child_process.spawn with a fake EventEmitter that
// emits scripted stdout/stderr/close events. Each test wires the script
// for the calls it expects. No real subprocess is ever started.
//
// We also stub node:fs/promises.stat so assertHyperframesProject sees a
// "project exists" world without a fixture directory on disk.

import { EventEmitter } from "node:events";
import { join } from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks. Hoisted to the top of the file because vi.mock is hoisted itself.
// ---------------------------------------------------------------------------

const spawnCalls: Array<{ args: ReadonlyArray<string>; cwd?: string }> = [];
let spawnScript: Array<{ stdout: string; stderr: string; code: number }> = [];

vi.mock("node:child_process", () => {
  return {
    spawn: vi.fn(
      (
        _binary: string,
        args: ReadonlyArray<string>,
        opts: { cwd?: string },
      ) => {
        spawnCalls.push({ args, cwd: opts?.cwd });
        const next = spawnScript.shift();
        if (!next) {
          throw new Error(
            `spawn script exhausted -- unexpected call: ${args.join(" ")}`,
          );
        }
        const child = new EventEmitter() as unknown as {
          stdout: EventEmitter;
          stderr: EventEmitter;
          stdin: { end: () => void; write: () => void };
          kill: () => void;
        } & EventEmitter;
        const stdoutEmitter = new EventEmitter();
        const stderrEmitter = new EventEmitter();
        (child as unknown as Record<string, unknown>).stdout = stdoutEmitter;
        (child as unknown as Record<string, unknown>).stderr = stderrEmitter;
        (child as unknown as Record<string, unknown>).stdin = {
          end: () => {},
          write: () => {},
        };
        (child as unknown as Record<string, unknown>).kill = () => {};
        // Schedule async emissions so the listeners are attached first.
        setImmediate(() => {
          if (next.stdout) {
            stdoutEmitter.emit("data", Buffer.from(next.stdout, "utf8"));
          }
          if (next.stderr) {
            stderrEmitter.emit("data", Buffer.from(next.stderr, "utf8"));
          }
          (child as EventEmitter).emit("close", next.code);
        });
        return child;
      },
    ),
  };
});

vi.mock("node:fs/promises", () => {
  return {
    stat: vi.fn(async () => ({ isFile: () => true })),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
  };
});

// ---------------------------------------------------------------------------
// SUT -- imported AFTER the mocks above.
// ---------------------------------------------------------------------------

import {
  createHyperframesProvider,
  HyperframesLintError,
  HyperframesLayoutError,
} from "../src/index.js";

beforeEach(() => {
  spawnCalls.length = 0;
  spawnScript = [];
});

describe("createHyperframesProvider", () => {
  const projectRoot = "/fake/venture/06_media/hf";

  it("available() returns true when doctor reports ok", async () => {
    spawnScript = [
      { stdout: '{"ok": true}', stderr: "", code: 0 },
    ];
    const provider = createHyperframesProvider({ projectRoot });
    expect(await provider.available()).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.args).toEqual(["doctor", "--json"]);
    expect(spawnCalls[0]?.cwd).toBe(projectRoot);
  });

  it("available() returns false when doctor reports not-ok", async () => {
    spawnScript = [
      { stdout: '{"ok": false}', stderr: "", code: 0 },
    ];
    const provider = createHyperframesProvider({ projectRoot });
    expect(await provider.available()).toBe(false);
  });

  it("available() returns false on doctor crash", async () => {
    spawnScript = [
      { stdout: "", stderr: "boom", code: 1 },
    ];
    const provider = createHyperframesProvider({ projectRoot });
    expect(await provider.available()).toBe(false);
  });

  it("render() runs lint then render for a shot with no hero timestamps", async () => {
    spawnScript = [
      // lint
      { stdout: '{"errorCount":0,"warningCount":0,"findings":[]}', stderr: "", code: 0 },
      // render
      { stdout: "", stderr: "rendered ok", code: 0 },
    ];
    const provider = createHyperframesProvider({ projectRoot });
    const result = await provider.render(
      {
        sceneId: "intro",
        engineHint: "hyperframes",
        prompt: "title slide",
        durationSec: 6,
      },
      "/fake/venture/06_media/renders",
    );
    expect(result.engine).toBe("hyperframes");
    expect(result.path).toBe(
      join("/fake/venture/06_media/renders", "shot-intro.mp4"),
    );
    expect(result.durationSec).toBe(6);
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]?.args).toEqual(["lint", "--json"]);
    expect(spawnCalls[1]?.args[0]).toBe("render");
    // No --variables-file, no --strict-variables when shot has no variables.
    expect(spawnCalls[1]?.args).not.toContain("--variables-file");
    expect(spawnCalls[1]?.args).not.toContain("--strict-variables");
    // Default fps + quality landed.
    expect(spawnCalls[1]?.args).toContain("--fps");
    expect(spawnCalls[1]?.args).toContain("30");
    expect(spawnCalls[1]?.args).toContain("--quality");
    expect(spawnCalls[1]?.args).toContain("standard");
  });

  it("render() includes lint + inspect + render when shot has hero timestamps + variables", async () => {
    spawnScript = [
      { stdout: '{"errorCount":0,"warningCount":0,"findings":[]}', stderr: "", code: 0 },
      { stdout: '{"issues":[]}', stderr: "", code: 0 },
      { stdout: "", stderr: "ok", code: 0 },
    ];
    const provider = createHyperframesProvider({ projectRoot });
    await provider.render(
      {
        sceneId: "hero",
        engineHint: "hyperframes",
        prompt: "Q4 hero",
        variables: { title: "Q4", theme: "dark" },
        compositionId: "kpi-template",
        heroTimestamps: [0, 2.5, 5],
        durationSec: 8,
        fps: 60,
        qualityPreset: "high",
        deterministic: true,
      },
      "/fake/out",
    );
    expect(spawnCalls).toHaveLength(3);
    expect(spawnCalls[0]?.args).toEqual(["lint", "--json"]);
    expect(spawnCalls[1]?.args).toEqual(["inspect", "--at", "0,2.5,5", "--json"]);
    const renderArgs = spawnCalls[2]?.args ?? [];
    expect(renderArgs[0]).toBe("render");
    expect(renderArgs).toContain("--variables-file");
    expect(renderArgs).toContain("--strict-variables");
    expect(renderArgs).toContain("--fps");
    expect(renderArgs).toContain("60");
    expect(renderArgs).toContain("--quality");
    expect(renderArgs).toContain("high");
    expect(renderArgs).toContain("--docker");
  });

  it("render() throws HyperframesLintError when lint reports errors", async () => {
    spawnScript = [
      {
        stdout:
          '{"errorCount":1,"warningCount":0,"findings":[{"severity":"error","rule":"missing_gsap_script","message":"GSAP missing"}]}',
        stderr: "",
        code: 0,
      },
    ];
    const provider = createHyperframesProvider({ projectRoot });
    await expect(
      provider.render(
        {
          sceneId: "x",
          engineHint: "hyperframes",
          prompt: "p",
          durationSec: 5,
        },
        "/o",
      ),
    ).rejects.toBeInstanceOf(HyperframesLintError);
    expect(spawnCalls).toHaveLength(1);
  });

  it("render() throws HyperframesLayoutError on inspect errors", async () => {
    spawnScript = [
      { stdout: '{"errorCount":0,"warningCount":0,"findings":[]}', stderr: "", code: 0 },
      {
        stdout:
          '{"issues":[{"severity":"error","rule":"text_box_overflow","message":"hero overflow"}]}',
        stderr: "",
        code: 0,
      },
    ];
    const provider = createHyperframesProvider({ projectRoot });
    await expect(
      provider.render(
        {
          sceneId: "x",
          engineHint: "hyperframes",
          prompt: "p",
          heroTimestamps: [1.5],
          durationSec: 5,
        },
        "/o",
      ),
    ).rejects.toBeInstanceOf(HyperframesLayoutError);
    expect(spawnCalls).toHaveLength(2);
  });
});
