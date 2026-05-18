import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { spawnPocketbase, PocketbaseNotFoundError } from "../src/spawn.js";

type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: string) => void;
};

function mockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

describe("spawnPocketbase", () => {
  it("resolves with exit code + captured stdio on close", async () => {
    const child = mockChild();
    const spawnImpl = (() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = spawnPocketbase({
      binaryPath: "/fake/pocketbase",
      args: ["migrate", "up"],
      spawnImpl,
    });

    // Emit stdout/stderr then close asynchronously.
    setImmediate(() => {
      child.stdout.emit("data", "hello");
      child.stderr.emit("data", "warn");
      child.emit("close", 0);
    });

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("warn");
  });

  it("rejects with PocketbaseNotFoundError on ENOENT from spawn", async () => {
    const spawnImpl = (() => {
      const err = new Error("spawn ENOENT") as Error & { code: string };
      err.code = "ENOENT";
      throw err;
    }) as unknown as typeof import("node:child_process").spawn;

    await expect(
      spawnPocketbase({
        binaryPath: "/missing/pocketbase",
        args: ["serve"],
        spawnImpl,
      })
    ).rejects.toBeInstanceOf(PocketbaseNotFoundError);
  });

  it("rejects with PocketbaseNotFoundError when child emits ENOENT error", async () => {
    const child = mockChild();
    const spawnImpl = (() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = spawnPocketbase({
      binaryPath: "/fake/pocketbase",
      args: ["migrate"],
      spawnImpl,
    });

    setImmediate(() => {
      const err = new Error("ENOENT") as Error & { code: string };
      err.code = "ENOENT";
      child.emit("error", err);
    });

    await expect(promise).rejects.toBeInstanceOf(PocketbaseNotFoundError);
  });
});
