import { describe, expect, it } from "vitest";
import { decodeFrontmatter } from "../src/frontmatter";
import {
  resolveVaultNoteDir,
  resolveVaultNotePath,
  toWorkspaceRelative,
} from "../src/paths";
import {
  createMemoryFsPort,
  renderVaultNoteContent,
  writeVaultNote,
} from "../src/write";
import type { WriteVaultNoteInput } from "../src/types";

const NOW = "2026-05-18T00:00:00.000Z";

function makeInput(over: Partial<WriteVaultNoteInput> = {}): WriteVaultNoteInput {
  return {
    workspaceRoot: "/ws",
    ventureSlug: "dreamlauncher",
    noteType: "chat_summary",
    noteId: "note-abc",
    title: "Brand kickoff",
    sourceDocumentId: "src-1",
    itemIds: ["src-1#0", "src-1#1"],
    tags: ["chat", "brand"],
    confidence: "medium",
    now: NOW,
    variables: {
      chatTitle: "Brand kickoff",
      chatProvider: "ChatGPT",
      chatDate: "2026-05-17",
      turnCount: 12,
      summary: "We discussed the brand.",
      keyDecisions: [{ title: "Locked the name", content: "DreamLauncher." }],
      keyTasks: [{ title: "Buy domain", content: "Squarespace." }],
      transcript: "**User:** Hi\n**Assistant:** Hi back.",
    },
    ...over,
  };
}

describe("resolveVaultNoteDir / Path", () => {
  it("maps project-scoped notes to the right numbered subdir", () => {
    expect(
      resolveVaultNoteDir({
        workspaceRoot: "/ws",
        ventureSlug: "acme",
        noteType: "chat_summary",
      })
    ).toBe("ws/_vault/projects/acme/10_chat-summaries");
    expect(
      resolveVaultNoteDir({
        workspaceRoot: "/ws",
        ventureSlug: "acme",
        noteType: "image_note",
      })
    ).toBe("ws/_vault/projects/acme/20_document-summaries");
  });

  it("maps unsorted notes to _vault/unsorted/<bucket>/", () => {
    expect(
      resolveVaultNoteDir({
        workspaceRoot: "/ws",
        ventureSlug: null,
        noteType: "prompt_pack",
      })
    ).toBe("ws/_vault/unsorted/prompts");
  });

  it("sanitises noteId into a safe filename", () => {
    const p = resolveVaultNotePath({
      workspaceRoot: "/ws",
      ventureSlug: "acme",
      noteType: "decision_log",
      noteId: "Hello / world : weird",
    });
    expect(p.endsWith(".md")).toBe(true);
    const filename = p.split("/").pop() ?? "";
    // The filename portion must not carry whitespace, slashes, or colons --
    // the path itself obviously contains slashes between dirs.
    expect(filename).not.toMatch(/[\s/:]/);
    expect(filename).toMatch(/^Hello-world-weird\.md$/);
  });

  it("toWorkspaceRelative strips the workspace prefix", () => {
    expect(toWorkspaceRelative("/ws", "ws/_vault/projects/acme/30_decisions/x.md")).toBe(
      "_vault/projects/acme/30_decisions/x.md"
    );
  });
});

describe("renderVaultNoteContent", () => {
  it("produces frontmatter + sanitised body", () => {
    const r = renderVaultNoteContent(
      makeInput({
        variables: {
          chatTitle: "Brand kickoff <script>x()</script>",
          chatProvider: "ChatGPT",
          turnCount: 1,
          summary: "Body",
          transcript: "(trans)",
        },
      })
    );
    expect(r.content.startsWith("---\n")).toBe(true);
    expect(r.content).toMatch(/title:.*Brand kickoff/);
    // <script> stripped from the body even though it came in via variable
    expect(r.content).not.toMatch(/<script>/);
    expect(r.warnings.join(" ")).toMatch(/<script>/);
  });

  it("reports unresolved placeholders for missing required vars", () => {
    const r = renderVaultNoteContent(
      makeInput({
        variables: {
          chatTitle: "Hi",
          // missing: chatProvider, turnCount, summary, transcript, ...
        },
      })
    );
    expect(r.unresolvedPlaceholders).toEqual(
      expect.arrayContaining(["chatProvider", "turnCount", "summary", "transcript"])
    );
  });
});

describe("writeVaultNote", () => {
  it("writes the rendered note via the fs port and returns paths + frontmatter", async () => {
    const fs = createMemoryFsPort();
    const result = await writeVaultNote(makeInput(), fs);
    expect(result.absolutePath).toBe(
      "ws/_vault/projects/dreamlauncher/10_chat-summaries/note-abc.md"
    );
    expect(result.relativePath).toBe(
      "_vault/projects/dreamlauncher/10_chat-summaries/note-abc.md"
    );
    expect(fs.dirs.has("ws/_vault/projects/dreamlauncher/10_chat-summaries")).toBe(true);
    const written = fs.files.get(result.absolutePath);
    expect(written).toBeDefined();
    if (!written) throw new Error("expected file content");
    const decoded = decodeFrontmatter(written);
    expect(decoded.frontmatter.title).toBe("Brand kickoff");
    expect(decoded.frontmatter.projectSlug).toBe("dreamlauncher");
    expect(decoded.frontmatter.noteType).toBe("chat_summary");
    expect(decoded.frontmatter.tags).toEqual(["chat", "brand"]);
    expect(decoded.frontmatter.itemIds).toEqual(["src-1#0", "src-1#1"]);
    expect(decoded.frontmatter.confidence).toBe("medium");
    expect(decoded.body).toMatch(/Brand kickoff/);
  });

  it("places unsorted notes under _vault/unsorted/", async () => {
    const fs = createMemoryFsPort();
    const result = await writeVaultNote(
      makeInput({
        ventureSlug: null,
        noteType: "prompt_pack",
        noteId: "promptpack-1",
        variables: {
          packTitle: "Founder prompts",
          prompts: [{ title: "Pricing check", content: "Ask: do they want it?" }],
        },
      }),
      fs
    );
    expect(result.absolutePath).toBe("ws/_vault/unsorted/prompts/promptpack-1.md");
    const written = fs.files.get(result.absolutePath);
    expect(written).toBeDefined();
    if (!written) throw new Error("expected file content");
    expect(decodeFrontmatter(written).frontmatter.projectSlug).toBeNull();
  });

  it("throws on empty noteId", async () => {
    const fs = createMemoryFsPort();
    await expect(writeVaultNote(makeInput({ noteId: "" }), fs)).rejects.toThrow(
      /noteId must not be empty/
    );
  });

  it("threads warnings + unresolved placeholders into the result", async () => {
    const fs = createMemoryFsPort();
    const result = await writeVaultNote(
      makeInput({
        variables: {
          chatTitle: "Hi <script>bad()</script>",
          chatProvider: "ChatGPT",
          turnCount: 1,
          summary: "Body",
          transcript: "(trans)",
        },
      }),
      fs
    );
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.unresolvedPlaceholders).toBeDefined();
  });
});
