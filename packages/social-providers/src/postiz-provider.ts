/**
 * Postiz SocialAdapter -- TIER_1.
 *
 * Drives a self-hosted Postiz instance via its REST API. Per spec sec 7:
 *   - available()    GET /api/v1/health -- fast, no rate-limit cost.
 *   - loginState()   GET /api/v1/integrations -- map per-integration
 *                    status onto our SocialPlatform login enum.
 *   - post()         For each media file: POST /api/v1/upload (caching
 *                    by sha256 to skip duplicates). Then POST
 *                    /api/v1/posts with one row per platform; honour
 *                    payload.scheduleAt server-side.
 *
 * Auth + base URL come from PostizConfig (resolved by the adapter
 * factory from a passed-in env snapshot, mirroring supabase-provider).
 * The API key is NEVER persisted to venture.yaml -- only its env-var
 * NAME is.
 *
 * Local-host guard: when PostizConfig.allowRemoteOnly === true the
 * adapter refuses to call non-localhost / non-LAN hosts. Mirrors the
 * crm-providers assertLocalHost guard.
 */

import {
  type PostizConfig,
  type SocialAdapter,
  type SocialAvailability,
  type SocialLoginState,
  type SocialPlatform,
  type SocialPost,
  type SocialResult,
  type SocialResultRow,
} from "@founder-os/social-core";

import {
  assertLocalPostizHost,
  createPostizPost,
  listPostizIntegrations,
  postizHealthProbe,
  PostizHealthError,
  PostizHttpError,
  PostizMediaUploadError,
  PostizRemoteHostBlockedError,
  uploadPostizMedia,
  type FetchLike,
  type PostizCreatePostResponse,
} from "./postiz-http.js";

// Re-export the error classes so the adapter and the BackendTab can
// share imports through the same barrel.
export {
  PostizHealthError,
  PostizHttpError,
  PostizMediaUploadError,
  PostizRemoteHostBlockedError,
};

// ---------------------------------------------------------------------------
// Options + factory
// ---------------------------------------------------------------------------

export type CreatePostizProviderOpts = {
  config: PostizConfig;
  /**
   * Snapshot of process.env (or equivalent). Required so the factory
   * can resolve the API key without coupling to process.env directly --
   * matches the supabase-provider pattern.
   */
  env: Record<string, string | undefined>;
  /**
   * Injectable fetch implementation. Production callers omit this; tests
   * inject a stub that returns canned Response objects without touching
   * the network.
   */
  fetchImpl?: FetchLike;
  /**
   * Read a media file from disk for upload. Production callers omit
   * this; the default uses node:fs/promises. Tests inject a stub.
   * Returns the file bytes + a content-type hint derived from the
   * extension.
   */
  readMediaImpl?: (path: string) => Promise<{
    data: Uint8Array;
    filename: string;
    contentType: string;
  }>;
};

export function createPostizProvider(
  opts: CreatePostizProviderOpts
): SocialAdapter {
  const { config, env } = opts;
  const apiKey = env[config.apiKeyEnvVar];
  const baseUrl = (config.baseUrl ?? "").trim();
  const fetchImpl = opts.fetchImpl;
  const readMedia = opts.readMediaImpl ?? defaultReadMedia;

  const httpOpts = {
    baseUrl,
    apiKey: apiKey ?? "",
    fetchImpl,
  };

  // Per-instance cache: sha256 -> Postiz upload id. Avoids re-uploading
  // the same media file across multiple posts. Populated lazily in post().
  const uploadCache = new Map<string, string>();

  return {
    name: "postiz",

    async available(): Promise<SocialAvailability> {
      if (!baseUrl) {
        return {
          available: false,
          reason: "social.postiz.baseUrl not set on the venture manifest.",
        };
      }
      if (!apiKey) {
        return {
          available: false,
          reason: `${config.apiKeyEnvVar} env var is empty -- paste your Postiz API key first.`,
        };
      }
      if (config.allowRemoteOnly) {
        try {
          assertLocalPostizHost(baseUrl);
        } catch (err) {
          return {
            available: false,
            reason: (err as Error).message,
          };
        }
      }
      try {
        await postizHealthProbe(httpOpts);
        return { available: true };
      } catch (err) {
        return {
          available: false,
          reason: (err as Error).message,
        };
      }
    },

    async loginState(): Promise<SocialLoginState> {
      if (!apiKey || !baseUrl) return {};
      try {
        const integrations = await listPostizIntegrations(httpOpts);
        const out: SocialLoginState = {};
        for (const integration of integrations) {
          const platform = postizIntegrationToPlatform(integration.identifier);
          if (!platform) continue;
          out[platform] =
            integration.status === "expired" || integration.status === "error"
              ? "logged_out"
              : "logged_in";
        }
        return out;
      } catch {
        return {};
      }
    },

    async post(payload: SocialPost): Promise<SocialResult> {
      const postedAt = new Date().toISOString();

      if (!baseUrl || !apiKey) {
        return {
          ventureSlug: payload.ventureSlug,
          backend: "postiz",
          postedAt,
          rows: payload.platforms.map<SocialResultRow>((platform) => ({
            platform,
            success: false,
            error: !baseUrl
              ? "Postiz baseUrl not configured."
              : `${config.apiKeyEnvVar} env var not set.`,
            errorCode: "not-logged-in",
            timestamp: postedAt,
          })),
        };
      }

      if (config.allowRemoteOnly) {
        try {
          assertLocalPostizHost(baseUrl);
        } catch (err) {
          return {
            ventureSlug: payload.ventureSlug,
            backend: "postiz",
            postedAt,
            rows: payload.platforms.map<SocialResultRow>((platform) => ({
              platform,
              success: false,
              error: (err as Error).message,
              errorCode: "platform-down",
              timestamp: postedAt,
            })),
          };
        }
      }

      // Step 1 -- upload any media (with sha256 dedupe).
      const mediaIds: string[] = [];
      for (const ref of payload.media ?? []) {
        const cacheKey = ref.digestSha256 ?? `path:${ref.path}`;
        const cached = uploadCache.get(cacheKey);
        if (cached) {
          mediaIds.push(cached);
          continue;
        }
        try {
          const file = await readMedia(ref.path);
          const uploaded = await uploadPostizMedia(httpOpts, file);
          uploadCache.set(cacheKey, uploaded.id);
          mediaIds.push(uploaded.id);
        } catch (err) {
          // Single upload failure -> every platform fails with media-rejected.
          const msg = (err as Error).message;
          return {
            ventureSlug: payload.ventureSlug,
            backend: "postiz",
            postedAt,
            rows: payload.platforms.map<SocialResultRow>((platform) => ({
              platform,
              success: false,
              error: msg,
              errorCode: "media-rejected",
              timestamp: postedAt,
            })),
          };
        }
      }

      // Step 2 -- create one Postiz "post" per platform. Per-platform
      // overrides become per-row content overrides; otherwise base text.
      const overrides = payload.perPlatformOverrides ?? {};
      const requestPosts = payload.platforms.map((platform) => {
        const override = overrides[platform];
        const baseText = override?.text ?? payload.text;
        const hashtags = override?.hashtags ?? [];
        const content =
          hashtags.length === 0
            ? baseText
            : `${baseText} ${hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}`;
        return {
          integration: platformToPostizIntegration(platform),
          content,
          mediaIds: mediaIds.length === 0 ? undefined : mediaIds,
        };
      });

      let response: PostizCreatePostResponse;
      try {
        response = await createPostizPost(httpOpts, {
          posts: requestPosts,
          scheduleAt: payload.scheduleAt,
        });
      } catch (err) {
        const msg = (err as Error).message;
        return {
          ventureSlug: payload.ventureSlug,
          backend: "postiz",
          postedAt,
          rows: payload.platforms.map<SocialResultRow>((platform) => ({
            platform,
            success: false,
            error: msg,
            errorCode: "unknown",
            timestamp: postedAt,
          })),
        };
      }

      // Map Postiz's response onto our row shape, scheduled-aware.
      const responseByIntegration = new Map<string, typeof response.posts[number]>();
      for (const row of response.posts) {
        responseByIntegration.set(row.integration, row);
      }

      const rows: SocialResultRow[] = payload.platforms.map((platform) => {
        const r = responseByIntegration.get(
          platformToPostizIntegration(platform)
        );
        if (!r) {
          return {
            platform,
            success: false,
            error: "Postiz response missing this platform's row.",
            errorCode: "unknown",
            timestamp: postedAt,
          };
        }
        const success =
          (r.status === "scheduled" || r.status === "published" || !!r.releaseURL) &&
          !r.error;
        return {
          platform,
          success,
          postUrl: r.releaseURL,
          postId: r.id,
          error: r.error,
          errorCode: success ? undefined : "unknown",
          timestamp: postedAt,
        };
      });

      return {
        ventureSlug: payload.ventureSlug,
        backend: "postiz",
        postedAt,
        rows,
        rawAdapterPayload: {
          scheduled: !!payload.scheduleAt,
          response,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Internal mappers
// ---------------------------------------------------------------------------

const PLATFORM_TO_POSTIZ: Record<SocialPlatform, string> = {
  x: "x",
  instagram: "instagram",
  linkedin: "linkedin",
  facebook: "facebook",
  tiktok: "tiktok",
  youtube: "youtube",
  threads: "threads",
  bluesky: "bluesky",
  mastodon: "mastodon",
  reddit: "reddit",
  pinterest: "pinterest",
};

const POSTIZ_TO_PLATFORM: Record<string, SocialPlatform> =
  Object.fromEntries(
    Object.entries(PLATFORM_TO_POSTIZ).map(([k, v]) => [v, k as SocialPlatform])
  );

export function platformToPostizIntegration(
  platform: SocialPlatform
): string {
  return PLATFORM_TO_POSTIZ[platform];
}

export function postizIntegrationToPlatform(
  identifier: string
): SocialPlatform | null {
  return POSTIZ_TO_PLATFORM[identifier.toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Default media reader -- node:fs/promises. Lazy-imported so the file
// loads cleanly even when tests inject readMediaImpl and never call it.
// ---------------------------------------------------------------------------

async function defaultReadMedia(path: string): Promise<{
  data: Uint8Array;
  filename: string;
  contentType: string;
}> {
  const { readFile } = await import("node:fs/promises");
  const { basename, extname } = await import("node:path");
  const data = await readFile(path);
  const filename = basename(path);
  const contentType = guessContentType(extname(filename).toLowerCase());
  return { data: new Uint8Array(data), filename, contentType };
}

function guessContentType(ext: string): string {
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    default:
      return "application/octet-stream";
  }
}
