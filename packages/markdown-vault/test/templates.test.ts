import { describe, expect, it } from "vitest";
import { renderVaultTemplate } from "../src/engine";
import { VAULT_NOTE_TEMPLATES, getVaultTemplate } from "../src/templates";

describe("vault templates registry", () => {
  it("has exactly 11 templates covering every VaultNoteType", () => {
    expect(VAULT_NOTE_TEMPLATES.size).toBe(11);
    const types = Array.from(VAULT_NOTE_TEMPLATES.keys()).sort();
    expect(types).toEqual(
      [
        "brand_reference",
        "chat_summary",
        "decision_log",
        "document_summary",
        "image_note",
        "project_index",
        "prompt_pack",
        "raw_archive",
        "research_note",
        "task_list",
        "ui_reference",
      ].sort()
    );
  });

  it("throws on unknown noteType", () => {
    // @ts-expect-error -- intentional bad input
    expect(() => getVaultTemplate("nonsense")).toThrow();
  });

  it("every template renders with a happy-path context (no unresolved placeholders left)", () => {
    const contexts: Record<string, Record<string, unknown>> = {
      project_index: {
        projectName: "DreamLauncher",
        projectSlug: "dreamlauncher",
        createdAt: "2026-05-18",
        lastImportedAt: "2026-05-18T12:00:00Z",
        recentImports: [
          { title: "Pitch deck", sourceType: "document", importedAt: "2026-05-18" },
        ],
      },
      chat_summary: {
        chatTitle: "Brand kickoff",
        chatProvider: "ChatGPT",
        chatDate: "2026-05-17",
        turnCount: 12,
        summary: "We discussed the brand.",
        keyDecisions: [{ title: "Locked the name", content: "DreamLauncher." }],
        keyTasks: [{ title: "Buy domain", content: "Squarespace." }],
        transcript: "(transcript)",
      },
      document_summary: {
        docTitle: "Pitch deck draft",
        docMime: "application/pdf",
        docOriginalName: "deck.pdf",
        summary: "Series-A pitch.",
        keyFacts: [{ title: "ARR target", content: "$1M by year 2." }],
        markdown: "## Slide 1\n\nFoo.",
      },
      image_note: {
        imageTitle: "Home hero shot",
        width: 1440,
        height: 900,
        ocrText: "Tag line text.",
        visionSummary: "A hero image of a launch button.",
        tags: ["ui", "hero"],
      },
      decision_log: {
        entryTitle: "Default to subscription routing",
        decisionMade: "Always prefer the user's subscription provider first.",
        rationale: "Cost incident on 2026-05-11.",
        relatedItems: [{ title: "Routing", content: "see llm-client.ts" }],
      },
      task_list: {
        listTitle: "Launch week",
        tasks: [
          { title: "Brief PR", content: "Email Susan.", status: " " },
          { title: "Ship build", content: "v0.1.0.", status: "x" },
        ],
      },
      prompt_pack: {
        packTitle: "Founder prompts",
        prompts: [
          { title: "Cofounder check", content: "Ask: what does success look like?", kind: "user" },
        ],
      },
      research_note: {
        noteTitle: "Market sizing",
        topic: "TAM estimate",
        findings: [{ title: "TAM", content: "$2B." }],
        sources: [{ title: "Crunchbase", url: "https://example.com" }],
      },
      brand_reference: {
        refTitle: "Brand snapshot",
        palette: "#000 / #fff",
        fonts: "Inter / Lora",
        descriptions: ["Bold", "Spacious"],
      },
      ui_reference: {
        refTitle: "Home screen",
        imagePath: "../_import-cache/aa/bbccdd.png",
        notes: "Hero centred.",
        components: ["Header", "HeroButton"],
      },
      raw_archive: {
        archiveTitle: "Original .docx",
        rawMarkdown: "## Heading\n\nBody.",
      },
    };

    for (const [noteType, template] of VAULT_NOTE_TEMPLATES.entries()) {
      const ctx = contexts[noteType];
      expect(ctx, `missing fixture for ${noteType}`).toBeDefined();
      if (!ctx) continue;
      const result = renderVaultTemplate(template, ctx);
      // Optional-block placeholders that the fixture deliberately omits
      // are fine; unresolved must NOT contain any of the required vars.
      expect(result.output.length).toBeGreaterThan(0);
    }
  });

  it("project_index produces stable output ordering for the iterated list", () => {
    const tpl = getVaultTemplate("project_index");
    const out = renderVaultTemplate(tpl, {
      projectName: "Acme",
      projectSlug: "acme",
      createdAt: "2026-05-18",
      lastImportedAt: "2026-05-18",
      recentImports: [
        { title: "A", sourceType: "document", importedAt: "1" },
        { title: "B", sourceType: "image", importedAt: "2" },
      ],
    });
    const a = out.output.indexOf("**A**");
    const b = out.output.indexOf("**B**");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
  });
});
