/**
 * Stub-provider unit tests (slice 6 of the media arc).
 *
 * Wan2 / CogVideoX / Veo are typed stubs in slice 6: their factories
 * return MediaProvider instances with the correct `name`, but
 * available() returns false and render() throws a typed error.
 *
 * These tests pin:
 *   1. Each factory accepts its documented options without throwing
 *      at construction time.
 *   2. Each provider has the correct `name` on the MediaProvider
 *      interface (so the resolver maps them to the right MediaEngine).
 *   3. Each available() resolves to false (so the resolver never picks
 *      them and slice 7+ can swap the implementation in without
 *      changing callers).
 *   4. Each render() throws the typed error class.
 *
 * No subprocess/HTTP mocking needed -- stubs do no IO.
 */
import { describe, expect, it } from "vitest";
import {
  CogVideoXNotImplementedError,
  createCogVideoXProvider,
  createVeoProvider,
  createWan2Provider,
  VeoNotImplementedError,
  Wan2NotImplementedError,
} from "../src/index.js";

const fakeShot = {
  sceneId: "test-scene",
  engineHint: "auto" as const,
  prompt: "test",
  durationSec: 5,
};

describe("createWan2Provider (stub)", () => {
  it("accepts default opts and reports name=wan2", () => {
    const p = createWan2Provider();
    expect(p.name).toBe("wan2");
  });
  it("accepts full opts shape without throwing", () => {
    const p = createWan2Provider({
      comfyUiUrl: "http://localhost:8188",
      workflowPath: "/tmp/workflow.json",
      pollIntervalMs: 1000,
      timeoutMs: 300_000,
    });
    expect(p.name).toBe("wan2");
  });
  it("available() returns false (resolver never picks the stub)", async () => {
    const p = createWan2Provider();
    expect(await p.available()).toBe(false);
  });
  it("render() throws Wan2NotImplementedError", async () => {
    const p = createWan2Provider();
    await expect(p.render(fakeShot, "/out")).rejects.toBeInstanceOf(Wan2NotImplementedError);
  });
});

describe("createCogVideoXProvider (stub)", () => {
  it("accepts default opts and reports name=cogvideox", () => {
    const p = createCogVideoXProvider();
    expect(p.name).toBe("cogvideox");
  });
  it("accepts full opts shape without throwing", () => {
    const p = createCogVideoXProvider({
      pythonBin: "python3",
      scriptPath: "/tmp/render.py",
      modelVariant: "5b",
      timeoutMs: 300_000,
    });
    expect(p.name).toBe("cogvideox");
  });
  it("available() returns false", async () => {
    const p = createCogVideoXProvider();
    expect(await p.available()).toBe(false);
  });
  it("render() throws CogVideoXNotImplementedError", async () => {
    const p = createCogVideoXProvider();
    await expect(p.render(fakeShot, "/out")).rejects.toBeInstanceOf(CogVideoXNotImplementedError);
  });
});

describe("createVeoProvider (stub)", () => {
  it("requires apiKey and reports name=gemini_api", () => {
    const p = createVeoProvider({ apiKey: "test-key" });
    expect(p.name).toBe("gemini_api");
  });
  it("accepts full opts shape without throwing", () => {
    const p = createVeoProvider({
      apiKey: "test-key",
      model: "veo-3.1",
      pollIntervalMs: 5000,
      timeoutMs: 600_000,
    });
    expect(p.name).toBe("gemini_api");
  });
  it("available() returns false", async () => {
    const p = createVeoProvider({ apiKey: "test-key" });
    expect(await p.available()).toBe(false);
  });
  it("render() throws VeoNotImplementedError", async () => {
    const p = createVeoProvider({ apiKey: "test-key" });
    await expect(p.render(fakeShot, "/out")).rejects.toBeInstanceOf(VeoNotImplementedError);
  });
});
