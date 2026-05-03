/**
 * BaseAgent core behavior tests.
 *
 * Most-likely future-regression site: LLMs love to wrap JSON in markdown
 * code fences (```json ... ```) despite explicit instructions to return
 * raw JSON. The base class strips a single wrapping fence. Test that:
 *  - plain JSON parses
 *  - ```json fence is stripped
 *  - bare ``` fence is stripped
 *  - leading/trailing whitespace is tolerated
 *  - malformed JSON throws (caught by run() wrapper as AgentOutput.error)
 *  - run() wraps thrown errors into AgentOutput with status: "error"
 */
import { describe, expect, it } from "vitest";

import { BaseAgent } from "../src/agent-base.js";
import type { AgentInput, CallLlm } from "../src/types.js";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";

class TestAgent extends BaseAgent {
  readonly name = "TestAgent";
  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    return this.callJson(input.callLlm, "system", "user");
  }
}

function fixedLlm(reply: string | (() => Promise<string>)): CallLlm {
  return async () => (typeof reply === "string" ? reply : reply());
}

function makeInput(callLlm: CallLlm): AgentInput {
  return {
    prospectUrl: "https://x.com",
    memoryPath: "/m/memory.json",
    fs: new InMemoryFs(),
    callLlm,
  };
}

describe("BaseAgent.callJson", () => {
  const agent = new TestAgent();

  it("parses plain JSON", async () => {
    const out = await agent.run(makeInput(fixedLlm('{"a":1}')));
    expect(out.status).toBe("success");
    expect(out.data).toEqual({ a: 1 });
  });

  it("strips ```json ... ``` fence", async () => {
    const out = await agent.run(makeInput(fixedLlm('```json\n{"a":2}\n```')));
    expect(out.status).toBe("success");
    expect(out.data).toEqual({ a: 2 });
  });

  it("strips bare ``` ... ``` fence", async () => {
    const out = await agent.run(makeInput(fixedLlm('```\n{"a":3}\n```')));
    expect(out.status).toBe("success");
    expect(out.data).toEqual({ a: 3 });
  });

  it("tolerates leading/trailing whitespace around fence", async () => {
    const out = await agent.run(makeInput(fixedLlm('  \n```json\n{"a":4}\n```\n  ')));
    expect(out.status).toBe("success");
    expect(out.data).toEqual({ a: 4 });
  });

  it("returns AgentOutput.error on malformed JSON", async () => {
    const out = await agent.run(makeInput(fixedLlm("not json at all")));
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/JSON|Unexpected/);
  });

  it("returns AgentOutput.error when LLM throws", async () => {
    const out = await agent.run(
      makeInput(fixedLlm(() => Promise.reject(new Error("rate limit")))),
    );
    expect(out.status).toBe("error");
    expect(out.error).toBe("rate limit");
  });
});
