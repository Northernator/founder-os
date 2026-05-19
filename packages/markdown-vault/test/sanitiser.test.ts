import { describe, expect, it } from "vitest";
import { sanitiseVaultMarkdown } from "../src/sanitiser";

describe("sanitiseVaultMarkdown", () => {
  it("strips <script> blocks and reports the count", () => {
    const { output, warnings } = sanitiseVaultMarkdown(
      "Hello\n<script>alert(1)</script>\nWorld\n<script src=x />\n"
    );
    expect(output).not.toMatch(/<script/i);
    expect(output).toMatch(/Hello/);
    expect(output).toMatch(/World/);
    expect(warnings.join(" ")).toMatch(/stripped 2 <script>/);
  });

  it("strips inline event handlers from any tag", () => {
    const { output, warnings } = sanitiseVaultMarkdown(
      `<img src="x" onerror="bad()" onclick='hack()'/>`
    );
    expect(output).not.toMatch(/onerror|onclick/);
    expect(warnings.join(" ")).toMatch(/event handlers/);
  });

  it("normalises headings deeper than h4", () => {
    const input = "##### Very deep\n###### Even deeper\n# Top\n";
    const { output, warnings } = sanitiseVaultMarkdown(input);
    expect(output).toMatch(/^#### Very deep$/m);
    expect(output).toMatch(/^#### Even deeper$/m);
    expect(output).toMatch(/^# Top$/m);
    expect(warnings.join(" ")).toMatch(/normalised 2 headings/);
  });

  it("leaves fenced code blocks UNTOUCHED", () => {
    const input = [
      "Normal heading",
      "##### Should be normalised",
      "```javascript",
      "##### inside code stays as h5",
      "<script>alert(1)</script>",
      "```",
      "##### Also normalised",
    ].join("\n");
    const { output, warnings } = sanitiseVaultMarkdown(input);
    // Inside the fence, content stays verbatim:
    expect(output).toMatch(/##### inside code stays as h5/);
    expect(output).toMatch(/<script>alert\(1\)<\/script>/);
    // Outside the fence, headings normalise + would-be-scripts are gone:
    expect(output.split("\n").filter((l) => l === "#### Should be normalised").length).toBe(1);
    expect(output.split("\n").filter((l) => l === "#### Also normalised").length).toBe(1);
    expect(warnings.join(" ")).toMatch(/normalised 2 headings/);
  });

  it("returns input unchanged when there's nothing to sanitise", () => {
    const md = "# Hi\n\nNormal markdown with no html.\n";
    const { output, warnings } = sanitiseVaultMarkdown(md);
    expect(output.replace(/\n+$/, "")).toBe(md.replace(/\n+$/, ""));
    expect(warnings).toEqual([]);
  });

  it("handles tilde-fenced code blocks too", () => {
    const input = ["~~~", "<script>bad()</script>", "~~~"].join("\n");
    const { output } = sanitiseVaultMarkdown(input);
    expect(output).toMatch(/<script>bad\(\)<\/script>/);
  });
});
