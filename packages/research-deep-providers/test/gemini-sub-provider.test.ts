/**
 * gemini-sub provider tests.
 *
 * Mocks node:child_process.spawn so the suite never shells out.
 * Mirrors the spawn-mock pattern in @founder-os/media-providers' tests.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// IMPORTANT: vi.mock has to come before the import-under-test, but the
// factory closes over `currentSpawnImpl` so each test can swap behaviour.
let currentSpawnImpl: (binary: string, args: string[]) => FakeChild = () => {
  throw new Error("spawn mock not installed for this test");
};

vi.mock("node:child_process", () => ({
  spawn: (binary: string, args: string[]) => currentSpawnImpl(binary, args),
}));
// fs.existsSync is used by the PATH×PATHEXT resolver — neutralise it so we
// don't accidentally probe the real machine's PATH.
vi.mock("node:fs", () => ({
  existsSync: () => false,
}));

// Import AFTER mocks so the provider gets the mocked spawn.
import { createGeminiSubProvider } from "../src/node.js";
import type { ResearchTopicOpts } from "@founder-os/research-deep-core";

const sampleTopic: ResearchTopicOpts = {
  topic: { slug: "icp", label: "Ideal customer profile" },
  questions: [
    {
      id: "q-1",
      question: "Who is the ideal customer for this product?",
      angle: "customer",
      priority: "must",
    },
  ],
  ventureContext: "Subscription-based meal prep service for UK runners.",
  accessedAt: "2026-05-18T09:00:00.000Z",
};

const goodGeminiOutput = `## Ideal customer

UK runners aged 28-44 who train 4+ times a week and value time-saving meals.

**Sources consulted:**
- Sport England Active Lives, Sport England, accessed 2026-05-18 — https://www.sportengland.org/active-lives
- Statista UK Running Participation, Statista, accessed 2026-05-18 — https://www.statista.com/uk-running
`;

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };
  kill = vi.fn();
}

function installSuccessSpawn(stdoutChunks: string[], exitCode = 0) {
  currentSpawnImpl = () => {
    const child = new FakeChild();
    setImmediate(() => {
      for (const chunk of stdoutChunks) {
        child.stdout.emit("data", Buffer.from(chunk, "utf8"));
      }
      child.emit("close", exitCode);
    });
    return child;
  };
}

function installFailureSpawn(stderr: string, exitCode = 1) {
  currentSpawnImpl = () => {
    const child = new FakeChild();
    setImmediate(() => {
      child.stderr.emit("data", Buffer.from(stderr, "utf8"));
      child.emit("close", exitCode);
    });
    return child;
  };
}

function installEnoentSpawn() {
  currentSpawnImpl = () => {
    const child = new FakeChild();
    setImmediate(() => {
      const err = new Error("spawn ENOENT") as Error & { code?: string };
      err.code = "ENOENT";
      child.emit("error", err);
    });
    return child;
  };
}

beforeEach(() => {
  // Reset to a "no spawn impl installed" guard so missing setup is loud.
  currentSpawnImpl = () => {
    throw new Error("spawn mock not installed for this test");
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createGeminiSubProvider", () => {
  it("reports name=gemini-sub", () => {
    const p = createGeminiSubProvider();
    expect(p.name).toBe("gemini-sub");
  });

  it("available() returns true when `gemini --version` exits 0", async () => {
    installSuccessSpawn([], 0);
    const p = createGeminiSubProvider();
    expect(await p.available()).toBe(true);
  });

  it("available() returns false when `gemini --version` exits non-zero", async () => {
    installFailureSpawn("not installed", 127);
    const p = createGeminiSubProvider();
    expect(await p.available()).toBe(false);
  });

  it("available() returns false on ENOENT", async () => {
    installEnoentSpawn();
    const p = createGeminiSubProvider();
    expect(await p.available()).toBe(false);
  });

  it("researchTopic parses gemini-cli stdout into sections + sources", async () => {
    installSuccessSpawn([goodGeminiOutput], 0);
    const p = createGeminiSubProvider();
    const partial = await p.researchTopic(sampleTopic);
    expect(partial.sections).toHaveLength(1);
    expect(partial.sections[0]?.heading).toBe("Ideal customer");
    expect(partial.sources).toHaveLength(2);
    expect(partial.sources.every((s) => s.retrievedBy === "gemini-sub")).toBe(true);
  });

  it("researchTopic feeds system + user prompt to stdin", async () => {
    let capturedStdin = "";
    currentSpawnImpl = () => {
      const child = new FakeChild();
      child.stdin.write = vi.fn((payload: string) => {
        capturedStdin += payload;
        return true;
      });
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(goodGeminiOutput, "utf8"));
        child.emit("close", 0);
      });
      return child;
    };
    const p = createGeminiSubProvider();
    await p.researchTopic(sampleTopic);
    expect(capturedStdin).toContain("[System instruction]");
    expect(capturedStdin).toContain("deep research analyst");
    expect(capturedStdin).toContain("[User request]");
    expect(capturedStdin).toContain("Ideal customer profile");
    expect(capturedStdin).toContain("UK runners");
  });

  it("researchTopic throws GeminiExitError on non-zero exit", async () => {
    installFailureSpawn("rate limit", 1);
    const p = createGeminiSubProvider();
    await expect(p.researchTopic(sampleTopic)).rejects.toMatchObject({
      name: "GeminiExitError",
    });
  });

  it("researchTopic surfaces GeminiNotFoundError on ENOENT", async () => {
    installEnoentSpawn();
    const p = createGeminiSubProvider();
    await expect(p.researchTopic(sampleTopic)).rejects.toMatchObject({
      name: "GeminiNotFoundError",
    });
  });

  it("researchTopic throws GeminiSubInvocationError when stdout is empty", async () => {
    installSuccessSpawn([""], 0);
    const p = createGeminiSubProvider();
    await expect(p.researchTopic(sampleTopic)).rejects.toMatchObject({
      name: "GeminiSubInvocationError",
    });
  });
});
