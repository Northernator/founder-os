import type { VentureStage } from "@founder-os/domain";

export type TemplateVars = Record<string, string | number | boolean | undefined>;

/** Simple Mustache-style template renderer — {{key}} → value */
export function render(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = vars[key];
    return val !== undefined ? String(val) : `{{${key}}}`;
  });
}

export const STAGE_FIRST_MESSAGE: Record<VentureStage, string> = {
  IDEA: "Welcome! Tell me about your idea — what problem are you solving and for whom?",
  RESEARCHED: "Great — you've done your initial research. Let's validate whether this is worth building. What does your customer research tell you?",
  VALIDATED: "Your idea is validated! Time to build your brand. What direction are you thinking for the name and visual identity?",
  BRAND_READY: "Brand is locked in — nice work. Now let's sort the UK business setup. Do you want to go sole trader or Ltd?",
  UK_SETUP_READY: "Business is set up. Now let's write the product spec. What are the core user stories for MVP?",
  SPEC_READY: "Spec's ready. Let's create wireframes. Are you using Figma, or should we generate screens via AI?",
  WIREFRAME_READY: "Wireframes done. Time to export to Stitch/v0 for the design-to-code pass. Ready to go?",
  STITCH_READY: "Stitch export ready. Sending to the VS Code extension for the build phase. This is where it gets exciting!",
  BUILD_READY: "Code is generating! Let's review the output and plan the audit pass.",
  AUDIT_READY: "Build complete. Running the audit — checking security, performance, and compliance.",
  LAUNCH_READY: "Audit passed! You're ready to launch. Let's go through the launch checklist.",
  LIVE: "You're live! 🚀 Let's talk about your first 30 days — growth, feedback loops, and what to build next.",
};

export const AUDIT_PROMPT_TEMPLATE = `
You are performing a code audit for {{ventureName}} (venture ID: {{ventureId}}).

Review the following for:
1. **Security** — injection, auth bypass, data exposure, OWASP Top 10
2. **Performance** — N+1 queries, missing indexes, blocking operations
3. **UK Compliance** — GDPR/UK GDPR, ICO requirements, cookie consent
4. **Accessibility** — WCAG 2.1 AA minimum
5. **Code quality** — type safety, error handling, test coverage

Return findings as structured JSON matching the AuditSummary schema.
Severity levels: critical | high | medium | low | info
`;

export const HANDOFF_SYSTEM_PROMPT = `
You are the Founder OS builder agent running inside VS Code.
You have received a HandoffBundle from the desktop app.

Your job:
1. Read the bundle payload carefully
2. Produce the requested artifacts (code, docs, configs)
3. Write them to the correct venture workspace paths
4. Emit progress events as you go
5. Write a HandoffResult when done

Be thorough. Be careful. Prefer TypeScript. Test as you go.
`;
