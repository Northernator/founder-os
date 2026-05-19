import type { VaultNoteFrontmatter } from "@founder-os/vault-contract";
import { describe, expect, it } from "vitest";
import {
  decodeFrontmatter,
  encodeFrontmatter,
} from "../src/frontmatter";

describe("frontmatter encode/decode", () => {
  const baseline: VaultNoteFrontmatter = {
    title: "Brand kickoff",
    sourceDocumentId: "src-abc",
    projectSlug: "dreamlauncher",
    noteType: "chat_summary",
    tags: ["chat", "brand"],
    itemIds: ["src-abc#0", "src-abc#1"],
    confidence: "medium",
    createdAt: "2026-05-18T00:00:00.000Z",
  };

  it("round-trips a complete frontmatter block", () => {
    const encoded = encodeFrontmatter(baseline);
    const decoded = decodeFrontmatter(`${encoded}\n# Body\n\nHi.`);
    expect(decoded.frontmatter).toEqual(baseline);
    expect(decoded.body).toBe("# Body\n\nHi.");
  });

  it("handles a null projectSlug", () => {
    const fm = { ...baseline, projectSlug: null };
    const encoded = encodeFrontmatter(fm);
    expect(encoded).toMatch(/projectSlug:\s*null/);
    const decoded = decodeFrontmatter(`${encoded}\n`);
    expect(decoded.frontmatter.projectSlug).toBeNull();
  });

  it("quotes strings containing colons or special chars", () => {
    const fm: VaultNoteFrontmatter = {
      ...baseline,
      title: "Re: Q3 review -- v2",
      itemIds: ["src#1", "src#2"],
    };
    const encoded = encodeFrontmatter(fm);
    expect(encoded).toMatch(/title:\s*"Re: Q3 review -- v2"/);
    const decoded = decodeFrontmatter(`${encoded}\n`);
    expect(decoded.frontmatter.title).toBe("Re: Q3 review -- v2");
  });

  it("encodes empty arrays as `[]` and decodes back", () => {
    const fm: VaultNoteFrontmatter = {
      ...baseline,
      tags: [],
      itemIds: [],
    };
    const encoded = encodeFrontmatter(fm);
    expect(encoded).toMatch(/tags:\s*\[\]/);
    const decoded = decodeFrontmatter(`${encoded}\n`);
    expect(decoded.frontmatter.tags).toEqual([]);
    expect(decoded.frontmatter.itemIds).toEqual([]);
  });

  it("throws when the opening fence is missing", () => {
    expect(() => decodeFrontmatter("no fence at all")).toThrow(
      /missing leading.*fence/
    );
  });

  it("throws when the closing fence is missing", () => {
    expect(() =>
      decodeFrontmatter("---\ntitle: x\nsourceDocumentId: s\n")
    ).toThrow(/missing closing/);
  });

  it("omits `confidence` when not provided and round-trips", () => {
    const { confidence: _drop, ...rest } = baseline;
    const fm = rest as VaultNoteFrontmatter;
    const encoded = encodeFrontmatter(fm);
    expect(encoded).not.toMatch(/confidence:/);
    const decoded = decodeFrontmatter(`${encoded}\n`);
    expect(decoded.frontmatter.confidence).toBeUndefined();
  });
});
