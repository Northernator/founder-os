/**
 * Config-only CrmProvider.
 *
 * The always-available fallback. Makes ZERO HTTP calls and spawns ZERO
 * subprocesses. Every "upsert" method captures the input on an in-memory
 * record that the runner reads back and writes to 11_crm/*.json.
 *
 * This keeps the contract uniform: the runner code doesn't branch on
 * engine -- the same CrmProvider methods are called regardless, and
 * config_only is just the implementation that stays in-memory.
 */

import type {
  CrmCampaign,
  CrmCampaignResult,
  CrmContact,
  CrmEmailTemplate,
  CrmInstance,
  CrmOpportunity,
  CrmProvider,
  CrmSegment,
  ProvisionInput,
} from "@founder-os/crm-core";

export type ConfigOnlyProviderOpts = {
  /**
   * Optional clock injection for tests so the provisionedAt timestamp
   * is deterministic. Defaults to () => new Date().toISOString().
   */
  now?: () => string;
};

export function createConfigOnlyProvider(
  opts: ConfigOnlyProviderOpts = {}
): CrmProvider & {
  /**
   * Snapshot of everything that's been captured. The runner reads this
   * after run() finishes and serialises it under 11_crm/.
   */
  snapshot(): {
    segments: CrmSegment[];
    contacts: CrmContact[];
    opportunities: CrmOpportunity[];
    templates: CrmEmailTemplate[];
    campaigns: CrmCampaign[];
  };
} {
  const now = opts.now ?? (() => new Date().toISOString());

  const segments: CrmSegment[] = [];
  const contacts: CrmContact[] = [];
  const opportunities: CrmOpportunity[] = [];
  const templates: CrmEmailTemplate[] = [];
  const campaigns: CrmCampaign[] = [];

  return {
    name: "config_only" as const,

    async available() {
      return true;
    },

    async provision(input: ProvisionInput): Promise<CrmInstance> {
      return {
        ventureSlug: input.ventureSlug,
        engine: "config_only",
        siteUrl: undefined,
        siteName: undefined,
        adminEmail: input.adminEmail,
        apiKeyRef: undefined,
        provisionedAt: now(),
        notes:
          "config_only -- no Frappe instance was created. JSON exports written under 11_crm/.",
      };
    },

    async upsertSegments(items) {
      segments.push(...items);
    },

    async upsertContacts(items) {
      contacts.push(...items);
    },

    async upsertOpportunities(items) {
      opportunities.push(...items);
    },

    async upsertTemplates(items) {
      templates.push(...items);
    },

    async createCampaign(campaign: CrmCampaign): Promise<CrmCampaignResult> {
      campaigns.push(campaign);
      return { id: campaign.id, url: undefined };
    },

    snapshot() {
      return {
        segments: [...segments],
        contacts: [...contacts],
        opportunities: [...opportunities],
        templates: [...templates],
        campaigns: [...campaigns],
      };
    },
  };
}
