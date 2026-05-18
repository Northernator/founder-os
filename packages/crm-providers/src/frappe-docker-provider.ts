/**
 * Frappe Docker CrmProvider (tier_0).
 *
 * Slice 2 ships the wrapper shell: available() checks whether the Docker
 * daemon is reachable and whether the venture's compose project is
 * already running. provision() and the upsert* methods delegate to the
 * underlying FrappeClient.
 *
 * Slice 7 wires the actual bootstrap orchestrator (compose write, up -d,
 * wait-for-ping, install-app crm, generate_keys) via the `bootstrap`
 * callback in FrappeDockerProviderOpts. Callers (the Node sidecar from
 * slice 5b, the CLI, integration tests) build the callback by adapting
 * `bootstrapDockerStack` from ./docker-bootstrap.ts -- they own the file
 * IO + asset resolution + credential encryption surface, the provider
 * just needs "give me apiKey + apiSecret when the stack is live."
 *
 * If the caller does NOT pass `bootstrap`, provision() against a fresh
 * machine throws DockerBootstrapNotImplementedError as before -- that
 * lets the resolver route to bench / config_only without surprise.
 */

import {
  CRM_DOCKER_DEFAULT_PORT,
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
import {
  DockerNotFoundError,
  spawnDocker,
  type DockerSpawnOpts,
} from "./spawn.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DockerBootstrapNotImplementedError extends Error {
  override readonly name = "DockerBootstrapNotImplementedError";
  constructor() {
    super(
      "Docker bootstrap not implemented yet -- slice 7 ships the compose " +
        "file + first-boot install. Until then, point at an already-running " +
        "compose project (via crm_compose_status) or fall back to bench/config."
    );
  }
}

// ---------------------------------------------------------------------------
// Options + factory
// ---------------------------------------------------------------------------

/**
 * Context handed to the bootstrap callback. The provider has already
 * resolved port + composeProject + siteUrl by the time it calls the
 * callback, so the callback doesn't have to duplicate that logic.
 */
export type DockerBootstrapContext = {
  ventureSlug: string;
  port: number;
  composeProject: string;
  siteUrl: string;
  /**
   * "fresh" when no compose project was running before this call,
   * "reused" when one was already up but loadCredentials returned null
   * (so we still need the caller to surface api-key + secret). Lets the
   * bootstrap callback take a different code path -- e.g. read encrypted
   * creds from disk for "reused", versus running the full first-boot
   * install for "fresh".
   */
  state: "fresh" | "reused";
};

/**
 * What the bootstrap callback returns. apiKey + apiSecret unlock the
 * FrappeClient. `notes` flows through to CrmInstance.notes for surfacing
 * in the gate UI.
 */
export type DockerBootstrapHandoff = {
  apiKey: string;
  apiSecret: string;
  notes?: string;
};

export type FrappeDockerProviderOpts = {
  /**
   * Venture slug -- used to scope the compose project name to
   * `founder-os-crm-<slug>`.
   */
  ventureSlug: string;
  /**
   * Host port the Frappe web container binds. Defaults to
   * CRM_DOCKER_DEFAULT_PORT (8000).
   */
  port?: number;
  /**
   * Function that returns the decrypted API key+secret pair once the
   * compose project is running. Returning null short-circuits provision()
   * to the bootstrap callback (slice 7) -- which on a fresh machine runs
   * the compose-up + first-boot install + generate_keys flow, and on a
   * reused project reads stored credentials.
   */
  loadCredentials: () => Promise<{ apiKey: string; apiSecret: string } | null>;
  /**
   * Slice 7: bootstrap the Docker compose stack and return credentials.
   *
   * The provider invokes this whenever it can't reach a ready FrappeClient
   * -- either because no compose project is running, or because one is
   * running but loadCredentials returned null. Callers adapt
   * `bootstrapDockerStack` from ./docker-bootstrap.ts: they own assets,
   * file IO, encryption (and, for "reused", reading the on-disk key
   * back). Returning credentials transitions the provider to "live".
   *
   * When omitted, provision() throws DockerBootstrapNotImplementedError
   * so the resolver can route to bench / config_only.
   */
  bootstrap?: (
    input: ProvisionInput,
    context: DockerBootstrapContext,
  ) => Promise<DockerBootstrapHandoff>;
  /**
   * Optional injected docker spawner (tests use this). Defaults to
   * spawn.spawnDocker.
   */
  spawnDockerImpl?: (opts: DockerSpawnOpts) => Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>;
  /**
   * Optional injected fetch (tests use this). Passed through to the
   * frappe-client.
   */
  fetchImpl?: typeof fetch;
  /**
   * Optional clock injection for tests.
   */
  now?: () => string;
};

export function createFrappeDockerProvider(
  opts: FrappeDockerProviderOpts
): CrmProvider {
  const port = opts.port ?? CRM_DOCKER_DEFAULT_PORT;
  const siteUrl = `http://localhost:${port}`;
  const composeProject = `founder-os-crm-${opts.ventureSlug}`;
  const now = opts.now ?? (() => new Date().toISOString());
  const dockerSpawn = opts.spawnDockerImpl ?? spawnDocker;

  let client: FrappeClient | null = null;
  let probedAvailable: boolean | null = null;

  /**
   * Build a FrappeClient from explicit credentials. Used after the
   * bootstrap callback hands back fresh keys.
   */
  function setClientFromCredentials(creds: {
    apiKey: string;
    apiSecret: string;
  }): void {
    client = createFrappeClient({
      siteUrl,
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      fetchImpl: opts.fetchImpl,
    });
  }

  async function dockerVersionOk(): Promise<boolean> {
    try {
      const res = await dockerSpawn({
        args: ["version", "--format", "{{.Server.Version}}"],
        timeoutMs: 2000,
      });
      return res.exitCode === 0;
    } catch (cause) {
      if (cause instanceof DockerNotFoundError) return false;
      return false;
    }
  }

  async function composeIsRunning(): Promise<boolean> {
    try {
      const res = await dockerSpawn({
        args: [
          "compose",
          "-p",
          composeProject,
          "ps",
          "--status",
          "running",
          "--format",
          "json",
        ],
        timeoutMs: 5000,
      });
      if (res.exitCode !== 0) return false;
      // compose ps --format json emits one JSON object per line.
      const lines = res.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      return lines.length > 0;
    } catch {
      return false;
    }
  }

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
    name: "frappe_docker" as const,

    async available() {
      if (probedAvailable !== null) return probedAvailable;
      probedAvailable = await dockerVersionOk();
      return probedAvailable;
    },

    async provision(input: ProvisionInput): Promise<CrmInstance> {
      // Already-running compose project? Treat it as authoritative.
      if (await composeIsRunning()) {
        const c = await ensureClient();
        if (c) {
          return {
            ventureSlug: input.ventureSlug,
            engine: "frappe_docker",
            siteUrl,
            siteName: "localhost",
            adminEmail: input.adminEmail,
            apiKeyRef: input.docker
              ? `~/.founder-os/crm/${input.ventureSlug}/api-key.enc`
              : undefined,
            provisionedAt: now(),
            notes: `Reusing running compose project "${composeProject}".`,
          };
        }
        // Compose is up but loadCredentials returned null. Slice 7
        // delegates to the bootstrap callback in "reused" mode -- it
        // either decrypts on-disk creds or asks Frappe to mint a new
        // key pair via /api/method/.../generate_keys. If no callback
        // was supplied we still hard-fail so the resolver can fall
        // through to bench / config_only.
        if (!opts.bootstrap) throw new DockerBootstrapNotImplementedError();
        const handoff = await opts.bootstrap(input, {
          ventureSlug: input.ventureSlug,
          port,
          composeProject,
          siteUrl,
          state: "reused",
        });
        setClientFromCredentials({
          apiKey: handoff.apiKey,
          apiSecret: handoff.apiSecret,
        });
        return {
          ventureSlug: input.ventureSlug,
          engine: "frappe_docker",
          siteUrl,
          siteName: "localhost",
          adminEmail: input.adminEmail,
          apiKeyRef: input.docker
            ? `~/.founder-os/crm/${input.ventureSlug}/api-key.enc`
            : undefined,
          provisionedAt: now(),
          notes:
            handoff.notes ??
            `Reusing running compose project "${composeProject}" with refreshed credentials.`,
        };
      }
      // Fresh provisioning: invoke the bootstrap callback if supplied.
      // Without one we hard-fail so the resolver routes to bench /
      // config_only -- this preserves the pre-slice-7 behaviour for
      // callers that haven't opted into bootstrap yet (e.g. the test
      // stubs).
      if (!opts.bootstrap) throw new DockerBootstrapNotImplementedError();
      const handoff = await opts.bootstrap(input, {
        ventureSlug: input.ventureSlug,
        port,
        composeProject,
        siteUrl,
        state: "fresh",
      });
      setClientFromCredentials({
        apiKey: handoff.apiKey,
        apiSecret: handoff.apiSecret,
      });
      return {
        ventureSlug: input.ventureSlug,
        engine: "frappe_docker",
        siteUrl,
        siteName: "localhost",
        adminEmail: input.adminEmail,
        apiKeyRef: input.docker
          ? `~/.founder-os/crm/${input.ventureSlug}/api-key.enc`
          : undefined,
        provisionedAt: now(),
        notes:
          handoff.notes ??
          `Bootstrapped fresh compose project "${composeProject}".`,
      };
    },

    async upsertSegments(segments: CrmSegment[]) {
      const c = await ensureClient();
      if (!c) return;
      for (const segment of segments) {
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
      const url = `${siteUrl}/app/newsletter/${encodeURIComponent(id)}`;
      return { id, url };
    },
  };
}
