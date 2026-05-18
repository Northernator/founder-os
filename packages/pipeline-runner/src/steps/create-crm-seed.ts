/**
 * createCrmSeedStep -- slice 4 of CRM arc.
 *
 * Reads upstream pipeline artifacts and seeds the resolved CrmProvider:
 *
 *  - Segments  ← /02_validation/icp/*.json (primary + optional secondary)
 *  - Contacts  ← packages/sales-agents pipeline.json (best effort) +
 *                /01_research/users-and-channels.md (opt-in via
 *                manifest.crm.seeding.importResearchContacts)
 *  - Opportunities ← qualified prospects from sales-agents
 *
 * All seed JSON is also written under 11_crm/{segments,contacts,opportunities}/
 * so config_only ventures (and any later re-import) have stable artifacts
 * on disk.
 *
 * Missing inputs degrade gracefully -- sales-agents output absent =>
 * zero contacts from that source, not a failure.
 */
import type {
  CrmContact,
  CrmOpportunity,
  CrmProvider,
  CrmSegment,
} from "@founder-os/crm-core";
import type { VentureManifest } from "@founder-os/domain";
import {
  getCrmContactsDir,
  getCrmDir,
  getCrmOpportunitiesDir,
  getCrmSegmentsDir,
} from "@founder-os/workspace-core";

import type { Filesystem } from "../fs.js";

export type CreateCrmSeedContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
  provider: CrmProvider;
  runId?: string;
};

export type CreateCrmSeedResult = {
  status: "done";
  segmentsUpserted: number;
  contactsUpserted: number;
  opportunitiesUpserted: number;
  artifactPaths: string[];
  /**
   * Per-source contact counts -- visible in the run log so the user
   * can see which paths contributed.
   */
  contactsBySource: {
    sales_agents: number;
    research_extract: number;
    manual: number;
  };
};

export async function createCrmSeedStep(
  ctx: CreateCrmSeedContext,
): Promise<CreateCrmSeedResult> {
  const artifactPaths: string[] = [];
  await ctx.fs.mkdir(getCrmDir(ctx.ventureRoot));

  // --- Segments --------------------------------------------------
  const segments: CrmSegment[] = [];
  const icpPrimary = await tryReadJson(
    ctx.fs,
    `${ctx.ventureRoot}/02_validation/icp/icp-primary.json`,
  );
  if (icpPrimary) {
    segments.push(icpToSegment("icp-primary", icpPrimary));
  }
  if (ctx.manifest.crm?.seeding?.secondaryIcpSegments !== false) {
    const icpSecondary = await tryReadJson(
      ctx.fs,
      `${ctx.ventureRoot}/02_validation/icp/icp-secondary.json`,
    );
    if (icpSecondary) {
      segments.push(icpToSegment("icp-secondary", icpSecondary));
    }
  }

  if (segments.length > 0) {
    await ctx.fs.mkdir(getCrmSegmentsDir(ctx.ventureRoot));
    for (const seg of segments) {
      const path = `${getCrmSegmentsDir(ctx.ventureRoot)}/${seg.id}.json`;
      await ctx.fs.writeFile(path, `${JSON.stringify(seg, null, 2)}\n`);
      artifactPaths.push(path);
    }
    await ctx.provider.upsertSegments(segments);
  }

  // --- Contacts --------------------------------------------------
  const contacts: CrmContact[] = [];
  const opportunities: CrmOpportunity[] = [];
  const bySource = { sales_agents: 0, research_extract: 0, manual: 0 };

  const salesPipeline = await tryReadJson(
    ctx.fs,
    `${ctx.ventureRoot}/08_launch/sales-pipeline.json`,
  );
  if (salesPipeline && Array.isArray(salesPipeline.prospects)) {
    for (const p of salesPipeline.prospects) {
      const contact = prospectToContact(p);
      if (contact) {
        contacts.push(contact);
        bySource.sales_agents += 1;
      }
      const opp = prospectToOpportunity(p);
      if (opp) opportunities.push(opp);
    }
  }

  if (ctx.manifest.crm?.seeding?.importResearchContacts) {
    const channelsMd = await tryReadString(
      ctx.fs,
      `${ctx.ventureRoot}/01_research/users-and-channels.md`,
    );
    if (channelsMd) {
      const extracted = extractEmailsFromMarkdown(channelsMd);
      for (const email of extracted) {
        contacts.push({
          email,
          source: "research_extract",
          segmentIds: ["research-prospects"],
        });
        bySource.research_extract += 1;
      }
    }
  }

  if (contacts.length > 0) {
    await ctx.fs.mkdir(getCrmContactsDir(ctx.ventureRoot));
    const dumpPath = `${getCrmContactsDir(ctx.ventureRoot)}/seed-contacts.json`;
    await ctx.fs.writeFile(dumpPath, `${JSON.stringify(contacts, null, 2)}\n`);
    artifactPaths.push(dumpPath);
    await ctx.provider.upsertContacts(contacts);
  }

  if (opportunities.length > 0) {
    await ctx.fs.mkdir(getCrmOpportunitiesDir(ctx.ventureRoot));
    const dumpPath = `${getCrmOpportunitiesDir(ctx.ventureRoot)}/seed-opportunities.json`;
    await ctx.fs.writeFile(dumpPath, `${JSON.stringify(opportunities, null, 2)}\n`);
    artifactPaths.push(dumpPath);
    await ctx.provider.upsertOpportunities(opportunities);
  }

  return {
    status: "done",
    segmentsUpserted: segments.length,
    contactsUpserted: contacts.length,
    opportunitiesUpserted: opportunities.length,
    artifactPaths,
    contactsBySource: bySource,
  };
}

// ----- Helpers ---------------------------------------------------------------

async function tryReadJson(
  fs: Filesystem,
  path: string,
): Promise<Record<string, unknown> | null> {
  if (!(await fs.exists(path))) return null;
  try {
    const raw = await fs.readFile(path);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function tryReadString(fs: Filesystem, path: string): Promise<string | null> {
  if (!(await fs.exists(path))) return null;
  try {
    return await fs.readFile(path);
  } catch {
    return null;
  }
}

function icpToSegment(id: string, icp: Record<string, unknown>): CrmSegment {
  const label = typeof icp.label === "string" ? icp.label : id;
  const industries = Array.isArray(icp.industries)
    ? icp.industries.filter((x): x is string => typeof x === "string")
    : undefined;
  const geography = Array.isArray(icp.geography)
    ? icp.geography.filter((x): x is string => typeof x === "string")
    : undefined;
  const jobsToBeDone = Array.isArray(icp.painPoints)
    ? icp.painPoints.filter((x): x is string => typeof x === "string")
    : undefined;

  let companySize: CrmSegment["criteria"]["companySize"];
  if (icp.companySize && typeof icp.companySize === "object") {
    const cs = icp.companySize as Record<string, unknown>;
    companySize = {};
    if (typeof cs.min === "number") companySize.min = cs.min;
    if (typeof cs.max === "number") companySize.max = cs.max;
  }

  const criteria: CrmSegment["criteria"] = {};
  if (industries) criteria.industries = industries;
  if (companySize) criteria.companySize = companySize;
  if (geography) criteria.geography = geography;
  if (jobsToBeDone) criteria.jobsToBeDone = jobsToBeDone;

  return { id, label, source: "validation_icp", criteria };
}

function prospectToContact(p: Record<string, unknown>): CrmContact | null {
  if (typeof p !== "object" || p === null) return null;
  const email = typeof p.email === "string" ? p.email : undefined;
  const firstName = typeof p.firstName === "string" ? p.firstName : undefined;
  const lastName = typeof p.lastName === "string" ? p.lastName : undefined;
  const company = typeof p.company === "string" ? p.company : undefined;
  const title = typeof p.title === "string" ? p.title : undefined;
  const externalId = typeof p.id === "string" ? p.id : undefined;
  const grade = typeof p.grade === "string" ? p.grade : undefined;

  // Skip entries with no useful identifying info at all.
  if (!email && !firstName && !company && !externalId) return null;

  const contact: CrmContact = {
    source: "sales_agents",
    segmentIds: ["icp-primary"],
  };
  if (externalId) contact.externalId = externalId;
  if (email) contact.email = email;
  if (firstName) contact.firstName = firstName;
  if (lastName) contact.lastName = lastName;
  if (company) contact.company = company;
  if (title) contact.title = title;
  if (grade) contact.notes = `sales-agents grade: ${grade}`;
  return contact;
}

function prospectToOpportunity(p: Record<string, unknown>): CrmOpportunity | null {
  if (typeof p !== "object" || p === null) return null;
  const status = typeof p.status === "string" ? p.status : undefined;
  const grade = typeof p.grade === "string" ? p.grade : undefined;
  // Only "qualified" prospects become opportunities -- the rest stay as
  // contacts only until the user works them in the CRM UI.
  if (status !== "qualified" && grade !== "A" && grade !== "B") return null;
  const company = typeof p.company === "string" ? p.company : "Unknown";
  const externalId = typeof p.id === "string" ? p.id : undefined;
  const opp: CrmOpportunity = {
    title: `${company} -- inbound interest`,
    status: "qualified",
    source: "sales_agents",
  };
  if (externalId) opp.contactExternalId = externalId;
  return opp;
}

const EMAIL_RX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
function extractEmailsFromMarkdown(md: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of md.matchAll(EMAIL_RX)) {
    const email = m[0].toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}
