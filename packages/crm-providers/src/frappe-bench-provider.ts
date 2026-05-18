/**
 * Frappe bench CrmProvider (tier_1).
 *
 * Assumes the user has a working `frappe-bench` install with a site
 * already running on localhost. The provider does NOT install bench --
 * that's deliberately out of scope; the user runs `bench` themselves
 * (or uses the Docker tier instead).
 *
 * available() succeeds when:
 *   1. siteUrl is reachable via /api/method/ping
 *   2. An API key+secret pair is loadable from the configured path
 *
 * If either fails, the resolver falls through to config_only.
 */

import {
  CRM_BENCH_DEFAULT_SITE_URL,
  type CrmCampaign,
  type CrmCampaignResult,
  type CrmContact,
  type CrmEmailTemplate,
  type CrmInstance,
  type CrmOpportunity,
  type CrmProvider,
  type CrmSegment,
  type ProvisionInput,
} from "@founder-os/crm-core";

import {
  createFrappeClient,
  type FrappeClient,
} from "./frappe-client.js";

export type FrappeBenchProviderOpts = {
  /**
   * Site URL. Must resolve to a localhost-class hostname.
   * Defaults to CRM_BENCH_DEFAULT_SITE_URL.
   */
  siteUrl?: string;
  /**
   * Function that returns the decrypted API key+secret pair. Async so
   * callers can read from an encrypted file on disk. Returning null
   * makes available() false.
   */
  loadCredentials: () => Promise<{ apiKey: string; apiSecret: string } | null>;
  /**
   * Optional clock injection for tests.
   */
  now?: () => string;
  /**
   * Optional injected fetch (tests use this). Passed through to the
   * frappe-client.
   */
  fetchImpl?: typeof fetch;
};

export function createFrappeBenchProvider(opts: FrappeBenchProviderOpts): CrmProvider {
  const siteUrl = opts.siteUrl ?? CRM_BENCH_DEFAULT_SITE_URL;
  const now = opts.now ?? (() => new Date().toISOString());

  let client: FrappeClient | null = null;
  let probedAvailable: boolean | null = null;

  async function ensureClient(): Promise<FrappeClient | null> {
    if (client) return client;
    const creds = await opts.loadCredentials();
    if (!creds) return null;
    client = createFrappeClient({
      siteUrl,
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      fetchImpl: opts.fetchImpl,
    });
    return client;
  }

  return {
    name: "frappe_bench" as const,

    async available() {
      if (probedAvailable !== null) return probedAvailable;
      try {
        const c = await ensureClient();
        if (!c) {
          probedAvailable = false;
          return false;
        }
        const ok = await c.ping();
        probedAvailable = ok;
        return ok;
      } catch {
        probedAvailable = false;
        return false;
      }
    },

    async provision(input: ProvisionInput): Promise<CrmInstance> {
      // The bench provider doesn't create sites; it points at an existing one.
      // available() already verified the site responds + credentials load.
      return {
        ventureSlug: input.ventureSlug,
        engine: "frappe_bench",
        siteUrl,
        siteName: new URL(siteUrl).hostname,
        adminEmail: input.adminEmail,
        apiKeyRef: input.bench?.apiKeyPath,
        provisionedAt: now(),
        notes: `Reusing existing bench site at ${siteUrl}.`,
      };
    },

    async upsertSegments(segments: CrmSegment[]) {
      const c = await ensureClient();
      if (!c) return;
      for (const segment of segments) {
        // Tags in Frappe are POSTed to the Tag DocType; the CRM app uses
        // tags + lead-source as the segment surrogate.
        await c.request({
          method: "POST",
          path: "/api/resource/Tag",
          body: { name: segment.id, description: segment.label },
        });
      }
    },

    async upsertContacts(contacts: CrmContact[]) {
      const c = await ensureClient();
      if (!c) return;
      for (const contact of contacts) {
        await c.request({
          method: "POST",
          path: "/api/resource/CRM Lead",
          body: {
            first_name: contact.firstName,
            last_name: contact.lastName,
            email_id: contact.email,
            company_name: contact.company,
            job_title: contact.title,
            source: contact.source,
          },
        });
      }
    },

    async upsertOpportunities(opps: CrmOpportunity[]) {
      const c = await ensureClient();
      if (!c) return;
      for (const opp of opps) {
        await c.request({
          method: "POST",
          path: "/api/resource/CRM Deal",
          body: {
            deal_name: opp.title,
            status: opp.status,
            annual_revenue: opp.estimatedValueGBP,
          },
        });
      }
    },

    async upsertTemplates(templates: CrmEmailTemplate[]) {
      const c = await ensureClient();
      if (!c) return;
      for (const tpl of templates) {
        await c.request({
          method: "POST",
          path: "/api/resource/Email Template",
          body: {
            name: tpl.id,
            subject: tpl.subject,
            response: tpl.body,
          },
        });
      }
    },

    async createCampaign(campaign: CrmCampaign): Promise<CrmCampaignResult> {
      const c = await ensureClient();
      if (!c) return { id: campaign.id, url: undefined };
      // Frappe Newsletter -- saved as draft. The pre-send review gate
      // surfaces this before any send.
      const res = await c.request<{ data?: { name?: string } }>({
        method: "POST",
        path: "/api/resource/Newsletter",
        body: {
          subject: campaign.label,
          email_group: campaign.segmentIds[0] ?? "all",
          message: `<!-- campaign:${campaign.id} -->`,
          send_from: "",
        },
      });
      const id = res?.data?.name ?? campaign.id;
      const url = `${siteUrl.replace(/\/$/, "")}/app/newsletter/${encodeURIComponent(id)}`;
      return { id, url };
    },
  };
}
