/**
 * createCrmCampaignTemplateStep -- slice 4 of CRM arc.
 *
 * Builds a 4-template welcome/follow-up pack from BRAND voice +
 * MEDIA launch announcement, then assembles a launch-campaign.json
 * that ties the templates to the primary ICP segment and embeds the
 * launch reel.
 *
 * LLM is optional. When provided, it's used to refine the body of
 * each template into the venture's brand voice. Subscription-mode
 * CLIs are preferred per project policy (the desktop helper
 * constructs the callLlm with that already routed). Without an LLM,
 * the step emits a deterministic-but-usable template set.
 *
 * The campaign is created via provider.createCampaign() but is NEVER
 * marked autoSend=true -- the pre-send review gate enforces this.
 */
import type {
  CrmCampaign,
  CrmCampaignResult,
  CrmEmailTemplate,
  CrmProvider,
} from "@founder-os/crm-core";
import type { VentureManifest } from "@founder-os/domain";
import {
  getCrmCampaignsDir,
  getCrmDir,
  getCrmLaunchCampaignPath,
  getCrmTemplatesDir,
  getLaunchReelPath,
} from "@founder-os/workspace-core";

import type { Filesystem } from "../fs.js";
import type { SaasLlmCaller } from "./create-saas-research-reports.js";

export type CreateCrmCampaignTemplateContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
  provider: CrmProvider;
  callLlm?: SaasLlmCaller;
  /**
   * Optional deep-research excerpts. When provided AND `callLlm` is set
   * AND brandVoice is present, the per-template rewrite prompt receives
   * a "Deep research context" block (current outreach patterns, send
   * timing, Frappe v1.7x merge-tag conventions). The LLM is instructed
   * to ground tone and hook timing in this material.
   */
  deepResearch?: { filename: string; excerpt: string }[];
  runId?: string;
};

export type CreateCrmCampaignTemplateResult = {
  status: "done";
  templates: CrmEmailTemplate[];
  campaign: CrmCampaign;
  campaignResult: CrmCampaignResult;
  artifactPaths: string[];
  /**
   * "llm" when LLM-enriched, "deterministic" when not.
   */
  generationSource: "llm" | "deterministic";
};

export async function createCrmCampaignTemplateStep(
  ctx: CreateCrmCampaignTemplateContext,
): Promise<CreateCrmCampaignTemplateResult> {
  const artifactPaths: string[] = [];
  await ctx.fs.mkdir(getCrmDir(ctx.ventureRoot));
  await ctx.fs.mkdir(getCrmTemplatesDir(ctx.ventureRoot));
  await ctx.fs.mkdir(getCrmCampaignsDir(ctx.ventureRoot));

  const brandVoice = await tryRead(
    ctx.fs,
    `${ctx.ventureRoot}/03_brand/brand-voice.md`,
  );
  const launchAnnouncement = await tryRead(
    ctx.fs,
    `${ctx.ventureRoot}/10_media/launch-announcement.md`,
  );

  // Build the 4-template seed set.
  const seedTemplates: CrmEmailTemplate[] = [
    {
      id: "email-welcome",
      subject: `Welcome to ${ctx.manifest.name}`,
      body: deterministicBody({
        kind: "welcome",
        ventureName: ctx.manifest.name,
        launchAnnouncement,
      }),
    },
    {
      id: "email-followup-1",
      subject: `Quick thought on ${ctx.manifest.name}`,
      body: deterministicBody({
        kind: "followup-1",
        ventureName: ctx.manifest.name,
        launchAnnouncement,
      }),
    },
    {
      id: "email-followup-2",
      subject: `A short demo of ${ctx.manifest.name}?`,
      body: deterministicBody({
        kind: "followup-2",
        ventureName: ctx.manifest.name,
        launchAnnouncement,
      }),
    },
    {
      id: "email-demo-invite",
      subject: "Want to see this in action?",
      body: deterministicBody({
        kind: "demo-invite",
        ventureName: ctx.manifest.name,
        launchAnnouncement,
      }),
    },
  ];

  let generationSource: "llm" | "deterministic" = "deterministic";
  let templates = seedTemplates;

  if (ctx.callLlm && brandVoice) {
    const researchBlock = ctx.deepResearch?.length
      ? ctx.deepResearch.map((r) => `### ${r.filename}\n\n${r.excerpt}`).join("\n\n")
      : "";
    try {
      const enrichedBodies = await Promise.all(
        seedTemplates.map(async (tpl) => {
          const userLines = [
            `Brand voice notes:\n${brandVoice.slice(0, 1500)}`,
            "",
            `Email kind: ${tpl.id}`,
            `Venture: ${ctx.manifest.name}`,
            `Existing draft:\n${tpl.body}`,
          ];
          if (researchBlock) {
            userLines.push("", `Deep research context:\n${researchBlock}`);
          }
          const enriched = await ctx.callLlm!({
            system:
              "You rewrite SaaS outreach emails in the founder's brand voice. " +
              "Keep them under 120 words. Preserve any {{ doc.first_name }} merge tags. " +
              "When a Deep research context block is present, use it to ground hook " +
              "patterns, send timing, and outreach conventions. " +
              "Output only the email body -- no subject, no signature block.",
            user: userLines.join("\n"),
          });
          return { ...tpl, body: enriched.trim() || tpl.body };
        }),
      );
      templates = enrichedBodies;
      generationSource = "llm";
    } catch {
      // Fallback to deterministic on any LLM failure.
      generationSource = "deterministic";
      templates = seedTemplates;
    }
  }

  // Write each template to disk.
  for (const tpl of templates) {
    const path = `${getCrmTemplatesDir(ctx.ventureRoot)}/${tpl.id}.md`;
    await ctx.fs.writeFile(
      path,
      `---\nsubject: ${tpl.subject}\n---\n\n${tpl.body}\n`,
    );
    artifactPaths.push(path);
  }

  await ctx.provider.upsertTemplates(templates);

  // Build the launch campaign. Embed the launch reel from MEDIA.
  const reelPath = getLaunchReelPath(ctx.ventureRoot);
  const reelExists = await ctx.fs.exists(reelPath);
  const campaign: CrmCampaign = {
    id: "launch-campaign",
    label: `${ctx.manifest.name} launch`,
    templateIds: templates.map((t) => t.id),
    segmentIds: ["icp-primary"],
    embeddedAssets: reelExists
      ? [
          {
            type: "video",
            sourcePath: "10_media/exports/launch-reel.mp4",
          },
        ]
      : [],
    autoSend: false,
  };

  const campaignPath = getCrmLaunchCampaignPath(ctx.ventureRoot);
  await ctx.fs.writeFile(campaignPath, `${JSON.stringify(campaign, null, 2)}\n`);
  artifactPaths.push(campaignPath);

  const campaignResult = await ctx.provider.createCampaign(campaign);

  return {
    status: "done",
    templates,
    campaign,
    campaignResult,
    artifactPaths,
    generationSource,
  };
}

async function tryRead(fs: Filesystem, path: string): Promise<string | null> {
  if (!(await fs.exists(path))) return null;
  try {
    return await fs.readFile(path);
  } catch {
    return null;
  }
}

type TemplateKind = "welcome" | "followup-1" | "followup-2" | "demo-invite";

function deterministicBody(opts: {
  kind: TemplateKind;
  ventureName: string;
  launchAnnouncement: string | null;
}): string {
  const tagline = opts.launchAnnouncement
    ? firstParagraph(opts.launchAnnouncement)
    : `We built ${opts.ventureName} to solve a problem that wasted hours every week.`;

  switch (opts.kind) {
    case "welcome":
      return [
        `Hi {{ doc.first_name }},`,
        "",
        `Thanks for the interest in ${opts.ventureName}.`,
        "",
        tagline,
        "",
        `If you have 5 minutes, I'd love to show you what it looks like in practice.`,
        "",
        `-- the ${opts.ventureName} team`,
      ].join("\n");
    case "followup-1":
      return [
        `Hi {{ doc.first_name }},`,
        "",
        `Following up on ${opts.ventureName}. The short version:`,
        "",
        tagline,
        "",
        `Three things it does well: a) automates the boring bits, b) cuts setup to minutes, c) stays out of your way the rest of the time.`,
        "",
        `Worth a quick look?`,
      ].join("\n");
    case "followup-2":
      return [
        `Hi {{ doc.first_name }},`,
        "",
        `Last note from me on ${opts.ventureName}.`,
        "",
        `Happy to record a 2-minute Loom showing the exact flow you'd use, or to point you at the live demo. Whichever is easier.`,
        "",
        `If now isn't the right time, no problem -- I'll close the loop.`,
      ].join("\n");
    case "demo-invite":
      return [
        `Hi {{ doc.first_name }},`,
        "",
        `Want to see ${opts.ventureName} in action?`,
        "",
        `Grab a 15-minute slot here: <calendly-link>`,
        "",
        `Or reply with a couple of times that work and I'll send an invite.`,
      ].join("\n");
  }
}

function firstParagraph(md: string): string {
  const trimmed = md.trim();
  const splitAt = trimmed.indexOf("\n\n");
  if (splitAt === -1) return trimmed.slice(0, 280);
  return trimmed.slice(0, splitAt).slice(0, 280);
}
