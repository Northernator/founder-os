/**
 * SaaS research reports — generate the founder-facing research docs
 * from an intake transcript. This is the one pipeline step that actually
 * calls an LLM, so it takes the LLM caller as an injected dependency
 * rather than hard-coding a provider. Keeps pipeline-runner free of API
 * key handling and provider-specific code.
 *
 * Inputs
 * ------
 *  - `manifest`       — venture.yaml (industry, appType, flags)
 *  - `ventureRoot`    — absolute path to the venture folder
 *  - `intake`         — text the founder has shared in the chat so far,
 *                       already concatenated with any attachment blocks
 *  - `callLlm`        — async function that takes a prompt pair and
 *                       returns the final assistant text
 *  - `fs`             — injected filesystem (Tauri or Node)
 *
 * Outputs (written under 01_research/saas/)
 * -----------------------------------------
 *   Core (shape of the opportunity):
 *     market-research.md
 *     prd.md
 *     business-model-and-pricing.md
 *     technical-architecture.md
 *   Product depth:
 *     user-flows-and-wireframes.md
 *     db-schema.md
 *     api-contracts.md
 *     security-and-permissions.md
 *   Go-to-market & operating:
 *     analytics-plan.md
 *     roadmap.md
 *     launch-plan.md
 *     support-and-onboarding.md
 *
 * Behaviour
 * ---------
 *  - All docs are generated concurrently, but with a pool cap (default 4)
 *    so we don't trip the provider's concurrent-request limit — 12
 *    parallel web-search streams to Anthropic reliably throttle.
 *  - If any calls fail we still write the ones that succeeded — partial
 *    output beats "nothing because one call timed out".
 *  - Existing files are NOT overwritten. If a doc already exists we skip
 *    it (and flag in the returned result). This lets the founder iterate
 *    on one doc in their editor without the next run blowing it away.
 *    Delete a doc to force a regenerate.
 *  - Each prompt is self-contained — they share the intake context but
 *    don't need prior outputs. Pool-safe regardless of order.
 */
import { createLogger } from "@founder-os/logger";
import { getStagePath } from "@founder-os/workspace-core";
import type { VentureManifest } from "@founder-os/domain";
import type { Filesystem } from "../fs.js";

const log = createLogger("pipeline-runner:create-saas-research-reports");

/**
 * Max in-flight LLM calls. Tuned for Anthropic — running 12 parallel
 * web_search streams reliably trips concurrent-request throttling. 4 has
 * empirically stayed under the line with headroom. OpenAI-compatible
 * providers tolerate more but the cap is intentionally conservative
 * because the pool is shared across providers.
 */
const REPORT_CONCURRENCY = 4;

/**
 * Minimal LLM caller interface. Takes a system+user pair, returns the
 * final assistant text. Caller is responsible for API keys, streaming,
 * cancellation — this step only cares about the final string.
 */
export type SaasLlmCaller = (prompt: {
  system: string;
  user: string;
}) => Promise<string>;

export type CreateSaasResearchReportsContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
  /** Concatenated chat transcript + attachment blocks. */
  intake: string;
  callLlm: SaasLlmCaller;
};

type ReportSpec = {
  filename: string;
  title: string;
  /** Short description surfaced in logs + return payload. */
  summary: string;
  /** Builds the user prompt from the intake context. System prompt is shared. */
  buildUserPrompt: (ctx: CreateSaasResearchReportsContext) => string;
};

type ReportOutcome =
  | { spec: ReportSpec; status: "written"; path: string }
  | { spec: ReportSpec; status: "skipped"; path: string; reason: string }
  | { spec: ReportSpec; status: "failed"; path: string; error: string };

/**
 * Shared system prompt for every report generator. Keeps them consistent
 * in tone + structure so a founder can read the full set in a row
 * without whiplash. Each report's user prompt then narrows focus.
 */
function sharedSystemPrompt(manifest: VentureManifest): string {
  return `You are writing a founder-facing research document for the SaaS venture "${manifest.name}".

Output rules:
- Write in Markdown.
- Start with an H1 title, then a one-paragraph TL;DR, then the body.
- Be specific to THIS venture — use the intake details the founder shared.
- Where you lack data, say so explicitly (e.g. "Unknown — requires customer interviews") rather than inventing numbers.
- UK context applies: regulators are Companies House, HMRC, ICO, FCA (if relevant). Currency defaults to GBP.
- Keep it tight. Roughly 600–1200 words. No filler.
- Use Markdown tables for comparisons and pricing tiers where helpful.

Venture context:
- Industry: ${manifest.industry ?? "general"}
- Regulated: ${manifest.regulated ? "yes" : "no"}
- Takes payments: ${manifest.takesPayments ? "yes" : "no"}
- Handles personal data: ${manifest.handlesPersonalData ? "yes" : "no"}`;
}

function intakeBlock(intake: string): string {
  const trimmed = intake.trim();
  if (!trimmed) return "No intake transcript was provided — flag missing information as 'Unknown'.";
  return `### Founder intake transcript\n\n${trimmed}`;
}

/**
 * The report catalogue. Order matters only for log readability — reports
 * run in a concurrency-capped pool (see `runWithConcurrency` below).
 * Changing a filename here means changing any Artifacts-tab / links that
 * reference it; prefer adding new reports over renaming.
 *
 * Grouped into three bands for skim-ability:
 *   1. Core — shape of the opportunity (market, PRD, pricing, tech)
 *   2. Product depth — what v1 actually is (flows, schema, APIs, security)
 *   3. GTM & operating — how it reaches users and stays healthy
 *      (analytics, roadmap, launch, support)
 */
const REPORT_SPECS: ReportSpec[] = [
  {
    filename: "market-research.md",
    title: "Market Research Report",
    summary: "TAM/SAM/SOM, ICP, competitive landscape, distribution",
    buildUserPrompt: (ctx) => `Write the **Market Research Report** for ${ctx.manifest.name}.

Required sections:
1. **TL;DR**
2. **Problem space** — whose pain, how acute, cost of "do nothing"
3. **Market size** — TAM / SAM / SOM with rough UK-focused estimates, cite assumptions
4. **Ideal Customer Profile (ICP)** — job title, company size, budget authority, where they hang out
5. **Competitive landscape** — table of direct competitors + pricing + positioning gap, plus indirect/adjacent threats
6. **Wedge hypothesis** — why this venture wins where incumbents can't
7. **Distribution hypotheses** — 3 concrete channels to reach the first 100 customers, ranked

${intakeBlock(ctx.intake)}`,
  },
  {
    filename: "prd.md",
    title: "Product Requirements Document (PRD)",
    summary: "Problem, users, scope, non-goals, success metrics",
    buildUserPrompt: (ctx) => `Write the **Product Requirements Document (PRD)** for ${ctx.manifest.name}.

Required sections:
1. **TL;DR** — one paragraph product summary
2. **Problem statement** — one sentence, quotable
3. **Target users** — primary + secondary personas with jobs-to-be-done
4. **Scope (v1)** — bullet list of capabilities, each a user-visible outcome
5. **Out of scope** — explicit non-goals for v1 (what we will NOT build)
6. **Key user journeys** — 3–5 narrative walkthroughs of the most important flows
7. **Success metrics** — north-star metric + 3 leading indicators with target thresholds
8. **Open questions** — things to resolve before build starts

${intakeBlock(ctx.intake)}`,
  },
  {
    filename: "business-model-and-pricing.md",
    title: "Business Model & Pricing",
    summary: "Revenue model, pricing tiers, unit economics, pricing rationale",
    buildUserPrompt: (ctx) => `Write the **Business Model & Pricing** document for ${ctx.manifest.name}.

Required sections:
1. **TL;DR**
2. **Revenue model** — subscription / usage / seat / hybrid; justify the choice
3. **Pricing tiers** — a Markdown table of 2–4 tiers with price (GBP/month), ideal customer, included features, and key limits. Give concrete numbers, not ranges.
4. **Pricing rationale** — why these numbers, anchored against the competitive pricing and willingness-to-pay signals
5. **Unit economics sketch** — rough CAC, LTV, payback period, gross margin assumptions. Flag unknowns.
6. **Monetisation risks** — free-tier abuse, enterprise carve-outs, churn drivers

${intakeBlock(ctx.intake)}`,
  },
  {
    filename: "technical-architecture.md",
    title: "Technical Architecture",
    summary: "Stack, components, data model sketch, build-vs-buy calls",
    buildUserPrompt: (ctx) => `Write the **Technical Architecture** document for ${ctx.manifest.name}.

Required sections:
1. **TL;DR**
2. **Recommended stack** — frontend, backend, database, auth, payments, hosting. Pick defaults and justify each (avoid "it depends"). UK-hosted options where GDPR matters.
3. **High-level components** — brief description of each service/module and its responsibility
4. **Data model sketch** — list the core entities + their key fields (no SQL yet — the DB schema doc comes later)
5. **Integrations** — external APIs the product needs (payments, email, analytics, LLM providers if relevant)
6. **Build vs buy** — for each major capability, call buy/build and explain why
7. **Key risks** — 3–5 technical risks (scaling, compliance, vendor lock-in) and mitigations
8. **v1 → v2 evolution** — what's OK to defer

${intakeBlock(ctx.intake)}`,
  },
  {
    filename: "user-flows-and-wireframes.md",
    title: "User Flows & Wireframes",
    summary: "Primary journeys + text-based wireframes for v1 screens",
    buildUserPrompt: (ctx) => `Write the **User Flows & Wireframes** document for ${ctx.manifest.name}.

Required sections:
1. **TL;DR**
2. **Primary user flows** — 3–5 end-to-end journeys written as numbered step lists. Include decision points and error/fallback branches.
3. **Screen inventory** — Markdown table of every v1 screen with its purpose and which flows it appears in
4. **Wireframe sketches** — for the 3–4 most important screens, render a low-fi layout inside a fenced \`\`\`text block using ASCII boxes (header / main / sidebar / CTAs). Name every interactive element.
5. **Empty / loading / error states** — call out what each key screen looks like when data is absent or a request fails
6. **Accessibility notes** — keyboard paths, contrast, focus order for the above screens

${intakeBlock(ctx.intake)}`,
  },
  {
    filename: "db-schema.md",
    title: "Database Schema",
    summary: "Tables, columns, constraints, indexes, relationships",
    buildUserPrompt: (ctx) => `Write the **Database Schema** document for ${ctx.manifest.name}. Assume PostgreSQL unless the intake clearly indicates otherwise.

Required sections:
1. **TL;DR** — one-paragraph shape of the data
2. **Entity list** — bullet list of every table with a one-line purpose
3. **Relationship overview** — a fenced \`\`\`mermaid block with an \`erDiagram\` showing table relationships. Keep to primary entities; make cardinalities explicit (\`||--o{\` etc.)
4. **Table definitions** — for each core table, a fenced \`\`\`sql CREATE TABLE block with columns, types (prefer \`text\`, \`uuid\`, \`timestamptz\`, \`jsonb\`), NOT NULL / DEFAULT constraints, foreign keys
5. **Indexes** — table of (table, columns, kind, reason) — justify each one with a query pattern
6. **Soft delete / audit strategy** — pick one (soft-delete column, audit table, event sourcing) and justify
7. **Migration strategy** — tool + naming convention + who runs prod migrations

${intakeBlock(ctx.intake)}`,
  },
  {
    filename: "api-contracts.md",
    title: "API Contracts",
    summary: "Endpoint inventory, auth, request/response shapes, errors",
    buildUserPrompt: (ctx) => `Write the **API Contracts** document for ${ctx.manifest.name}. Prefer REST + JSON unless the intake indicates otherwise.

Required sections:
1. **TL;DR**
2. **Conventions** — base URL pattern, versioning strategy, auth scheme (header format), content types, date format, pagination shape
3. **Error format** — the single canonical error envelope every endpoint uses (code, message, details). Include an example
4. **Endpoint inventory** — a Markdown table: Method · Path · Auth? · Purpose
5. **Endpoint detail** — for the 5–8 most important endpoints, document: path params, query params, request body (fenced JSON), response body (fenced JSON), status codes used, rate-limit tier
6. **Webhooks / async events** — if applicable: event names, delivery guarantees, retry behaviour, signature verification
7. **Open questions** — anything that still needs product input

${intakeBlock(ctx.intake)}`,
  },
  {
    filename: "security-and-permissions.md",
    title: "Security & Permissions",
    summary: "Auth, authz, data protection, threat model, GDPR for UK",
    buildUserPrompt: (ctx) => `Write the **Security & Permissions** document for ${ctx.manifest.name}.

Required sections:
1. **TL;DR**
2. **Authentication** — login methods (email/password, magic link, SSO, OAuth providers), password policy, session model, MFA posture
3. **Authorization model** — RBAC / ABAC / per-resource ACL; list concrete roles with the permissions each holds in a table
4. **Data classification** — what data is stored, what is sensitive (PII, payments, health), retention period per class
5. **Data protection** — encryption at rest, in transit, secret management, key rotation
6. **Audit logging** — what actions are logged, where logs live, retention
7. **Threat model (STRIDE-lite)** — pick the 5 highest-impact threats and note mitigations
8. **GDPR / UK compliance** — lawful basis, DSAR handling, sub-processors, breach process. If \`handlesPersonalData\` is false, say why not and what would trigger a change.
9. **Incident response** — severity scale + on-call pager path + comms template

${intakeBlock(ctx.intake)}`,
  },
  {
    filename: "analytics-plan.md",
    title: "Analytics Plan",
    summary: "North-star, event taxonomy, funnels, dashboards, tooling",
    buildUserPrompt: (ctx) => `Write the **Analytics Plan** for ${ctx.manifest.name}.

Required sections:
1. **TL;DR**
2. **North-star metric** — the single number the team steers by + why
3. **Leading indicators** — 3–5 weekly metrics that move before the north-star does
4. **Activation definition** — the concrete moment a new user becomes "activated"
5. **Event taxonomy** — a Markdown table of events: \`event_name\` (snake_case) · when fired · required properties · owner
6. **Funnels** — 2–3 key funnels defined step-by-step using the events above
7. **Dashboards** — which dashboards exist (acquisition, activation, retention, revenue), who owns each, review cadence
8. **Tooling** — recommend ONE analytics tool (PostHog, Amplitude, Mixpanel, etc.) and justify. Note GDPR implications (EU-hosted etc.)
9. **Experimentation** — A/B framework, minimum sample sizes, who approves tests

${intakeBlock(ctx.intake)}`,
  },
  {
    filename: "roadmap.md",
    title: "Roadmap",
    summary: "Phased milestones from v1 through v3 with dependencies",
    buildUserPrompt: (ctx) => `Write the **Roadmap** for ${ctx.manifest.name}.

Use phases (Now / Next / Later — or v1 / v2 / v3) rather than calendar dates; calendars lie, phases don't.

Required sections:
1. **TL;DR**
2. **Guiding principles** — 3–5 bullets that define what is and isn't in scope at each phase
3. **Now (v1)** — what ships to win the first cohort of paying users. Success criteria per milestone.
4. **Next (v2)** — what unlocks after v1 validation. Include trigger conditions for starting v2.
5. **Later (v3+)** — speculative bets, worth naming but not scoped in detail
6. **Dependencies & risks** — what could stall a phase (hiring, integrations, regulatory sign-off)
7. **Explicit non-goals** — features intentionally NOT built in the roadmap window
8. **Review cadence** — how often the roadmap is revisited and by whom

${intakeBlock(ctx.intake)}`,
  },
  {
    filename: "launch-plan.md",
    title: "Launch Plan",
    summary: "Pre-launch, launch-day, and 90-day post-launch playbook",
    buildUserPrompt: (ctx) => `Write the **Launch Plan** for ${ctx.manifest.name}.

Required sections:
1. **TL;DR**
2. **Launch goal** — one sentence: "by T+30 days we will have X" — something falsifiable
3. **Pre-launch (T-30 → T-1)** — waitlist, beta cohort, PR/outreach, asset production, technical dry-runs. Each item as a checklist row with owner.
4. **Launch day (T+0)** — hour-by-hour timeline: channels going live (Product Hunt, HN, Twitter/X, LinkedIn, newsletter), monitoring set, DRIs for each channel
5. **Post-launch sprint (T+1 → T+14)** — response cadence, content plan, customer-interview targets
6. **90-day iteration plan** — paid vs organic split, retention-focused ships, which metrics trigger which action
7. **Assets needed** — landing page, demo video, social graphics, press kit — owners + deadlines
8. **Kill criteria** — what would make you pull launch or roll back

${intakeBlock(ctx.intake)}`,
  },
  {
    filename: "support-and-onboarding.md",
    title: "Support & Onboarding",
    summary: "First-run experience, activation checklist, support model",
    buildUserPrompt: (ctx) => `Write the **Support & Onboarding** document for ${ctx.manifest.name}.

Required sections:
1. **TL;DR**
2. **First-run experience** — step-by-step from sign-up to activation. Name the "aha moment" and the time-to-value target.
3. **Activation checklist** — the concrete in-product checklist shown to new users; each item should move a leading metric
4. **Empty states** — for the 3–5 main screens, what the empty state says + primary CTA
5. **In-product help** — tooltips, docs links, contextual prompts, chat widget (yes/no, which)
6. **Support channels** — channels (email, chat, community, forum), hours, SLA per tier, escalation path
7. **Canned responses** — 5 pre-written replies for the most common questions; keep them human
8. **Churn triage** — signals that predict churn and the outreach template that fires
9. **Feedback loop** — how support insights make it back to product (tags, weekly review, who owns)

${intakeBlock(ctx.intake)}`,
  },
];

export async function createSaasResearchReportsStep(
  ctx: CreateSaasResearchReportsContext
): Promise<{
  status: "done" | "partial" | "failed";
  producedArtifactIds: string[];
  outcomes: ReportOutcome[];
}> {
  if (ctx.manifest.appType !== "saas") {
    // Hard guard — running the SaaS reports against a non-SaaS venture
    // would produce misleading docs. Caller should have filtered.
    throw new Error(
      `create-saas-research-reports: expected appType "saas", got "${ctx.manifest.appType}"`
    );
  }

  const outDir = `${getStagePath(ctx.ventureRoot, "research")}/saas`;
  await ctx.fs.mkdir(outDir);

  const system = sharedSystemPrompt(ctx.manifest);

  // Pooled generation. Per-report try/catch so a single bad call doesn't
  // nuke the others. Concurrency cap avoids tripping provider limits —
  // 12 simultaneous web-search streams to Anthropic reliably throttle.
  const tasks = REPORT_SPECS.map(
    (spec) => async (): Promise<ReportOutcome> => {
      const path = `${outDir}/${spec.filename}`;

      if (await ctx.fs.exists(path)) {
        log.info(`Skipping ${spec.filename} — already exists`);
        return {
          spec,
          status: "skipped",
          path,
          reason: "File already exists — delete it to regenerate",
        };
      }

      try {
        const user = spec.buildUserPrompt(ctx);
        log.info(`Generating ${spec.filename}…`);
        const text = await ctx.callLlm({ system, user });
        const cleaned = ensureTitle(text, spec.title);
        await ctx.fs.writeFile(path, cleaned);
        log.info(`Wrote ${spec.filename} (${cleaned.length} chars)`);
        return { spec, status: "written", path };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Failed ${spec.filename}: ${msg}`);
        return { spec, status: "failed", path, error: msg };
      }
    }
  );

  const outcomes: ReportOutcome[] = await runWithConcurrency(
    REPORT_CONCURRENCY,
    tasks
  );

  const anyWritten = outcomes.some((o) => o.status === "written");
  const anyFailed = outcomes.some((o) => o.status === "failed");
  const status: "done" | "partial" | "failed" = anyFailed
    ? anyWritten
      ? "partial"
      : "failed"
    : "done";

  return { status, producedArtifactIds: [], outcomes };
}

/**
 * Tiny worker-pool for async tasks. Preserves input order in the result
 * array. We avoid a dependency on p-limit / p-map etc. — pipeline-runner
 * is deliberately dep-light and the 15-line implementation is trivial.
 *
 * Each worker pulls from a shared cursor until the task list is drained,
 * so fast-finishing tasks don't leave slots idle while slow ones run.
 */
async function runWithConcurrency<T>(
  limit: number,
  tasks: Array<() => Promise<T>>
): Promise<T[]> {
  if (tasks.length === 0) return [];
  const results: T[] = new Array(tasks.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= tasks.length) return;
      // Non-null assertion is safe: we just bounds-checked `i`.
      results[i] = await tasks[i]!();
    }
  };
  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Some models wrap output in triple backticks or forget the H1. We
 * normalise lightly so the file opens as a real Markdown document.
 */
function ensureTitle(raw: string, fallbackTitle: string): string {
  let text = raw.trim();
  // Strip a leading ```markdown fence if the model added one.
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(text);
  if (fenced && fenced[1]) {
    text = fenced[1].trim();
  }
  if (!/^#\s+/.test(text)) {
    text = `# ${fallbackTitle}\n\n${text}`;
  }
  return text;
}
