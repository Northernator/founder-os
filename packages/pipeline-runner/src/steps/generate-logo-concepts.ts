/**
 * Logo concept generator — writes 4 `concept-0N.md` files under
 * `03_brand/logo/concepts/` describing four distinct visual directions
 * for the venture's logo mark.
 *
 * This step does NOT generate images — it produces written briefs that
 * a designer (or an image-gen tool down the line) can turn into actual
 * logos. Mirrors the pattern in `create-saas-research-reports.ts`:
 * concurrency-capped pool of per-concept LLM calls, existing files
 * skipped, partial success still writes what succeeded.
 *
 * The four concepts are intentionally different archetypes so a founder
 * can pick a direction rather than shuffling variations of the same
 * idea:
 *   01 — Geometric mark (abstract icon + wordmark)
 *   02 — Letterform (stylised monogram)
 *   03 — Metaphor (concrete object / creature with symbolic meaning)
 *   04 — Typographic (wordmark with distinctive treatment)
 */
import { createLogger } from "@founder-os/logger";
import { getLogoConceptsDir } from "@founder-os/workspace-core";
import type { BrandBrief } from "@founder-os/branding-core";
import type { Filesystem } from "../fs.js";

const log = createLogger("pipeline-runner:generate-logo-concepts");

/** Mirrored from the research reports step — kept dep-light. */
const CONCEPT_CONCURRENCY = 4;

export type LogoLlmCaller = (prompt: {
  system: string;
  user: string;
}) => Promise<string>;

export type GenerateLogoConceptsContext = {
  fs: Filesystem;
  ventureRoot: string;
  brief: BrandBrief;
  callLlm: LogoLlmCaller;
};

type ConceptSpec = {
  filename: string;
  /** Display title, also used as the H1 fallback if the model forgets one. */
  title: string;
  /** Short hook for the user prompt describing what direction this is. */
  archetype: string;
  directions: string;
};

type ConceptOutcome =
  | { spec: ConceptSpec; status: "written"; path: string }
  | { spec: ConceptSpec; status: "skipped"; path: string; reason: string }
  | { spec: ConceptSpec; status: "failed"; path: string; error: string };

const CONCEPT_SPECS: ConceptSpec[] = [
  {
    filename: "concept-01-geometric.md",
    title: "Concept 01 — Geometric Mark",
    archetype: "Geometric abstract mark + wordmark",
    directions: `An abstract geometric icon (circle, square, triangle, chevron, hexagon, interlocking shapes) paired with the wordmark.
- The icon reads at 16×16 (favicon) and 512×512 (app icon).
- Explain what the geometry *means* — e.g. "two overlapping chevrons signal acceleration, forward motion".
- Avoid cliché (no lightbulbs, no rockets, no puzzle pieces).`,
  },
  {
    filename: "concept-02-letterform.md",
    title: "Concept 02 — Letterform Monogram",
    archetype: "Stylised letterform / monogram",
    directions: `A single letter or 2-letter monogram treated as the primary mark.
- Describe what makes the letter *distinctive* — a custom curve, a ligature, a geometric alternation, negative space play.
- Reference 1-2 existing letterform logos as tonal anchors (Airbnb's 'A', Dropbox's 'D', Pinterest's 'P'), then state how this will differ.
- The letter should feel like it was drawn for this brand specifically, not set in a pre-existing typeface.`,
  },
  {
    filename: "concept-03-metaphor.md",
    title: "Concept 03 — Metaphor",
    archetype: "Concrete object / creature with symbolic meaning",
    directions: `A concrete object or creature that symbolises the brand's core promise.
- Pick something *specific* (not "an arrow", but "a seabird carrying a bundle" or "a brass compass with the N replaced by the company mark").
- State the metaphor in one sentence: what does this object tell the viewer about the brand in one glance?
- Note: metaphor marks are harder to pull off — they can feel childish if overplayed. Lean toward stylised, confident illustration, not mascots.`,
  },
  {
    filename: "concept-04-typographic.md",
    title: "Concept 04 — Typographic Treatment",
    archetype: "Wordmark with distinctive treatment",
    directions: `The whole brand name treated as the logo — no icon.
- Specify the typographic choice: custom lettering, a modified existing typeface (and say which), or a pure typesetting in a distinctive face.
- Call out 1-2 distinctive treatments: a swash, a ligature, a punctuation mark as a micro-illustration, a kerning play, a weight alternation.
- Address how it scales down: typographic logos often fall apart at 16×16 — what's the fallback mark?`,
  },
];

function sharedSystemPrompt(brief: BrandBrief): string {
  return `You are writing a logo concept brief for the brand "${brief.companyName}". You are a creative director briefing a designer — you are not the designer.

Output rules:
- Markdown. H1 title first, then a TL;DR paragraph, then the body sections in the order specified.
- Be specific. "A bold geometric mark" is not a brief — "A single upward chevron built from two 22.5° lines, offset by 12% for visual tension, set flush-left against the wordmark" IS a brief.
- Reference real brands for tonal anchors (e.g. "the weight of Notion's current mark, the warmth of Oatly's illustration style") but always describe how THIS mark will differ.
- Flag accessibility considerations: does it work in mono? On a dark background? At 16px?
- No filler. 400-700 words total.

Brand context:
- Company: ${brief.companyName}
- Tagline: ${brief.tagline}
- Mission: ${brief.mission}
- Audience: ${brief.targetAudience}
- Personality: ${brief.personality.join(", ")}
- Tone of voice: ${brief.toneOfVoice}
- Primary colour: ${brief.colorPalette.primary}
- Accent colour: ${brief.colorPalette.accent}
- Heading typeface: ${brief.typography.headingFont}
- Body typeface: ${brief.typography.bodyFont}

Required sections (use exactly these H2 headings):
1. **TL;DR** — one paragraph
2. **Concept** — what the mark *is* and what it communicates in one glance
3. **Execution notes** — specifics a designer can draw from (proportions, angles, relationship of icon to wordmark, weight, line quality)
4. **Reference anchors** — 2-3 existing brands as tonal references + how this will differ
5. **Monochrome & small-size behaviour** — how it holds up in one colour and at 16px
6. **Risks** — what could make this feel wrong / dated / derivative; how to avoid`;
}

function buildUserPrompt(spec: ConceptSpec, brief: BrandBrief): string {
  return `Write **${spec.title}** for ${brief.companyName}.

Archetype: ${spec.archetype}

Direction:
${spec.directions}

Write the full brief now.`;
}

export async function generateLogoConceptsStep(
  ctx: GenerateLogoConceptsContext
): Promise<{
  status: "done" | "partial" | "failed";
  outcomes: ConceptOutcome[];
}> {
  const outDir = getLogoConceptsDir(ctx.ventureRoot);
  await ctx.fs.mkdir(outDir);

  const system = sharedSystemPrompt(ctx.brief);

  const tasks = CONCEPT_SPECS.map(
    (spec) => async (): Promise<ConceptOutcome> => {
      const path = `${outDir}/${spec.filename}`;

      if (await ctx.fs.exists(path)) {
        log.info(`Skipping ${spec.filename} — already exists`);
        return {
          spec,
          status: "skipped",
          path,
          reason: "File already exists — delete to regenerate",
        };
      }

      try {
        const user = buildUserPrompt(spec, ctx.brief);
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

  const outcomes = await runWithConcurrency(CONCEPT_CONCURRENCY, tasks);

  const anyWritten = outcomes.some((o) => o.status === "written");
  const anyFailed = outcomes.some((o) => o.status === "failed");
  const status: "done" | "partial" | "failed" = anyFailed
    ? anyWritten
      ? "partial"
      : "failed"
    : "done";

  return { status, outcomes };
}

/**
 * Worker-pool helper — copy of the implementation in
 * `create-saas-research-reports.ts`. Kept local so the two steps stay
 * independent and we don't need a shared `lib/concurrency.ts` for
 * fifteen lines of code. If a third step needs this, promote it.
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
      results[i] = await tasks[i]!();
    }
  };
  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/** Strip ```markdown fences and prepend an H1 if the model forgot one. */
function ensureTitle(raw: string, fallbackTitle: string): string {
  let text = raw.trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(text);
  if (fenced && fenced[1]) {
    text = fenced[1].trim();
  }
  if (!/^#\s+/.test(text)) {
    text = `# ${fallbackTitle}\n\n${text}`;
  }
  return text;
}
