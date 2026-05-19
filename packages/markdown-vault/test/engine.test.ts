import { describe, expect, it } from "vitest";
import { renderVaultTemplate } from "../src/engine";

describe("renderVaultTemplate", () => {
  it("substitutes simple variables and reports unresolved", () => {
    const { output, unresolvedPlaceholders } = renderVaultTemplate(
      "Hello {{name}}, welcome to {{place}}.",
      { name: "Alex" }
    );
    expect(output).toBe("Hello Alex, welcome to .");
    expect(unresolvedPlaceholders).toEqual(["place"]);
  });

  it("expands {{#if}} blocks based on truthiness", () => {
    const { output } = renderVaultTemplate(
      "{{#if active}}ACTIVE: {{name}}{{/if}}",
      { active: true, name: "x" }
    );
    expect(output).toBe("ACTIVE: x");
    const empty = renderVaultTemplate(
      "{{#if active}}ACTIVE{{/if}}",
      { active: false }
    ).output;
    expect(empty).toBe("");
  });

  it("expands {{#each}} blocks with `this` resolving the item", () => {
    const { output } = renderVaultTemplate(
      "{{#each items}}- {{this}}\n{{/each}}",
      { items: ["a", "b", "c"] }
    );
    expect(output).toBe("- a\n- b\n- c\n");
  });

  it("expands {{#each}} with object items by dotted lookups", () => {
    const { output } = renderVaultTemplate(
      "{{#each people}}<{{name}}/{{age}}>{{/each}}",
      { people: [{ name: "Ada", age: 33 }, { name: "Lin", age: 28 }] }
    );
    expect(output).toBe("<Ada/33><Lin/28>");
  });

  it("strips {{!-- comments --}} before substitution", () => {
    const { output } = renderVaultTemplate(
      "{{!-- secret note --}}Hello {{name}}",
      { name: "x" }
    );
    expect(output).toBe("Hello x");
  });

  it("treats empty arrays and empty strings as falsy", () => {
    const { output: e1 } = renderVaultTemplate(
      "{{#if list}}yes{{/if}}",
      { list: [] }
    );
    expect(e1).toBe("");
    const { output: e2 } = renderVaultTemplate(
      "{{#if name}}yes{{/if}}",
      { name: "" }
    );
    expect(e2).toBe("");
  });
});
