/**
 * Standalone tests for ResearchClient + pollJob. Uses tsx + Node 18+
 * built-in test runner-ish style (manual asserts, no test framework
 * dep). Run with `pnpm -F @founder-os/research-runner test`.
 *
 * The tests inject a fetch mock so nothing actually hits the network.
 */

import assert from "node:assert/strict";

import { ResearchClient, ResearchClientError, pollJob } from "../src/index.js";
import type { JobRecord } from "../src/index.js";

let pass = 0;
let fail = 0;

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok ${name}`);
    pass++;
  } catch (err) {
    console.error(`  FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
    fail++;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

console.log("ResearchClient");

await run("baseUrl strips trailing slash", async () => {
  const c = new ResearchClient({
    baseUrl: "http://x:3030//",
    fetchImpl: (async () => jsonResponse({})) as typeof fetch,
  });
  assert.equal(c.baseUrl, "http://x:3030");
});

await run("createDeepResearch posts JSON to /research/deep", async () => {
  let captured: { url?: string; init?: RequestInit } = {};
  const fakeFetch: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init };
    return jsonResponse({
      job_id: "j-1",
      status: "queued",
      venture_slug: "smoke",
      poll: "/research/jobs/j-1",
    });
  }) as typeof fetch;
  const c = new ResearchClient({ baseUrl: "http://x", fetchImpl: fakeFetch });
  const accepted = await c.createDeepResearch({ venture_slug: "smoke", topic: "x", depth: 2 });
  assert.equal(accepted.job_id, "j-1");
  assert.equal(captured.url, "http://x/research/deep");
  assert.equal(captured.init?.method, "POST");
  const body = JSON.parse(String(captured.init?.body));
  assert.equal(body.venture_slug, "smoke");
  assert.equal(body.depth, 2);
});

await run("non-2xx response throws ResearchClientError carrying detail", async () => {
  const fakeFetch: typeof fetch = (async () =>
    new Response(JSON.stringify({ detail: "venture_slug invalid" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  const c = new ResearchClient({ baseUrl: "http://x", fetchImpl: fakeFetch });
  let caught: unknown;
  try {
    await c.createDeepResearch({ venture_slug: "BAD", topic: "x" });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ResearchClientError, "should be ResearchClientError");
  const e = caught as ResearchClientError;
  assert.equal(e.status, 400);
  assert.match(e.message, /venture_slug invalid/);
  assert.equal(e.isNetwork, false);
});

await run("network failure surfaces as ResearchClientError isNetwork=true", async () => {
  const fakeFetch: typeof fetch = (async () => {
    throw new TypeError("getaddrinfo ENOTFOUND");
  }) as typeof fetch;
  const c = new ResearchClient({ baseUrl: "http://nope", fetchImpl: fakeFetch });
  let caught: unknown;
  try {
    await c.health();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ResearchClientError);
  const e = caught as ResearchClientError;
  assert.equal(e.status, 0);
  assert.equal(e.isNetwork, true);
});

console.log("\npollJob");

await run("transitions queued -> running -> done and emits onProgress per change", async () => {
  let i = 0;
  const seq: JobRecord[] = [
    mkJob({ status: "queued", progress_message: "queued" }),
    mkJob({ status: "running", progress_message: "running step 1" }),
    mkJob({ status: "running", progress_message: "running step 1" }), // no change
    mkJob({ status: "running", progress_message: "writing report" }),
    mkJob({ status: "done", progress_message: "done", result: { ok: true } }),
  ];
  const fakeFetch: typeof fetch = (async () =>
    jsonResponse(seq[i++] ?? seq[seq.length - 1])) as typeof fetch;
  const c = new ResearchClient({ baseUrl: "http://x", fetchImpl: fakeFetch });
  const messages: string[] = [];
  const outcome = await pollJob(c, "j-1", {
    intervalMs: 1,
    timeoutMs: 1_000,
    onProgress: (r) => messages.push(r.progress_message),
  });
  assert.equal(outcome.kind, "done");
  // 4 distinct messages: queued, running step 1, writing report, done.
  assert.deepEqual(messages, ["queued", "running step 1", "writing report", "done"]);
});

await run("timeout returns kind=timeout when status never reaches done", async () => {
  const fakeFetch: typeof fetch = (async () =>
    jsonResponse(mkJob({ status: "running", progress_message: "stuck" }))) as typeof fetch;
  const c = new ResearchClient({ baseUrl: "http://x", fetchImpl: fakeFetch });
  const outcome = await pollJob(c, "j-1", { intervalMs: 1, timeoutMs: 5 });
  assert.equal(outcome.kind, "timeout");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

// ------------------------------ helpers -----------------------------

function mkJob(p: Partial<JobRecord>): JobRecord {
  const now = new Date().toISOString();
  return {
    job_id: "j-1",
    kind: "deep_research",
    status: "queued",
    venture_slug: "smoke",
    created_at: now,
    updated_at: now,
    progress_message: "",
    result: null,
    error: null,
    ...p,
  };
}
