/**
 * Template-engine tests. Covers the Handlebars-subset behaviour
 * renderPdfStep relies on: variable substitution, escape vs raw,
 * if-block and each-block expansion, lenient TODO callouts.
 */
import { describe, expect, it } from "vitest";
import {
  renderTemplate,
  HandoffPackTemplateError,
} from "../src/index.js";

describe("renderTemplate", () => {
  it("substitutes {{var}} with HTML-escaped values", () => {
    const result = renderTemplate(
      "Hello {{name}}",
      { name: "<Acme & Co>" },
      "strict"
    );
    expect(result.output).toBe("Hello &lt;Acme &amp; Co&gt;");
    expect(result.unresolvedPlaceholders).toHaveLength(0);
  });

  it("substitutes {{{var}}} without escaping (raw mode)", () => {
    const result = renderTemplate(
      "{{{html}}}",
      { html: "<b>bold</b>" },
      "strict"
    );
    expect(result.output).toBe("<b>bold</b>");
  });

  it("throws in strict mode when a placeholder is missing", () => {
    expect(() =>
      renderTemplate("Hello {{name}}", {}, "strict")
    ).toThrow(HandoffPackTemplateError);
  });

  it("produces a TODO callout in lenient mode for missing placeholders", () => {
    const result = renderTemplate(
      "Hello {{name}}",
      {},
      "lenient"
    );
    expect(result.output).toContain('class="hp-todo"');
    expect(result.output).toContain("TODO: name");
    expect(result.unresolvedPlaceholders).toEqual(["name"]);
  });

  it("expands {{#each}} over arrays of objects", () => {
    const result = renderTemplate(
      "{{#each items}}<li>{{label}}</li>{{/each}}",
      { items: [{ label: "A" }, { label: "B" }] },
      "strict"
    );
    expect(result.output).toBe("<li>A</li><li>B</li>");
  });

  it("expands {{#if var}}...{{/if}} based on truthiness", () => {
    const truthy = renderTemplate(
      "{{#if visible}}YES{{/if}}",
      { visible: true },
      "strict"
    );
    expect(truthy.output).toBe("YES");
    const falsy = renderTemplate(
      "{{#if visible}}YES{{/if}}",
      { visible: false },
      "strict"
    );
    expect(falsy.output).toBe("");
  });
});
