/**
 * run-social-post.ts -- WebView-side helpers for the SOCIAL-MODULE-SPEC arc.
 *
 * Round 3 wraps the four Tauri commands the desktop registers in
 * apps/founder-desktop/src-tauri/src/social.rs:
 *   1. social_probe_backend(backend, opts?)   -> available?
 *   2. social_login_state(backend, opts?)     -> per-platform login state
 *   3. social_post(payload, backend, ...)     -> SocialResult (+ persistence)
 *   4. social_open_post_log(ventureRoot)      -> opens 13_social/posts/ in OS
 *
 * Imports the WebView-safe types from @founder-os/social-core +
 * @founder-os/social-providers (root barrel). NEVER imports
 * @founder-os/social-providers/node -- that subpath spawns the `sp` CLI and
 * calls Postiz over HTTP, both of which Vite externalises to runtime-throw
 * stubs in the renderer (the blank-screen failure mode the media-providers
 * PM-split memory documents). The biome.json /node restriction blocks the
 * accidental import; this helper is the supported way to reach the Node
 * sidecar from React.
 *
 * The wrappers re-parse the Tauri response with zod on the way in so the rest
 * of the desktop never branches on raw IPC shapes -- callers always get a
 * typed SocialResult / SocialAvailability / SocialLoginState. Mirrors the
 * crm-providers slice 5b helper layout.
 */
import {
  parseSocialResult,
  type SocialAvailability,
  type SocialBackend,
  type SocialLoginState,
  type SocialPost,
  type SocialResult,
} from "@founder-os/social-core";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Options passed to every backend-aware command.
// ---------------------------------------------------------------------------

/**
 * Backend-tuning knobs. Each is forwarded verbatim to the Node CLI sidecar by
 * the matching Tauri command. Omitting them means "use the CLI's defaults":
 *   spBinary           -> "sp"
 *   postizApiKeyEnv    -> "POSTIZ_API_KEY"
 *   postizAllowRemote  -> false
 */
export type SocialAdapterOpts = {
  spBinary?: string;
  postizBaseUrl?: string;
  postizApiKeyEnv?: string;
  postizAllowRemoteOnly?: boolean;
};

// ---------------------------------------------------------------------------
// Raw IPC envelope shapes -- mirror cli.ts. Kept un-exported so consumers
// have to use the typed wrappers below.
// ---------------------------------------------------------------------------

type RawProbe =
  | { backend: SocialBackend; available: boolean; reason?: string }
  | { error: string };

type RawLoginState =
  | { backend: SocialBackend; state: Record<string, string> }
  | { error: string };

type ScheduledEnvelope = {
  fireAt: string;
  queuePath: string;
  fireCommand: string;
};

type RawPost =
  | {
      backend: SocialBackend;
      result: unknown;
      resultPath?: string;
      scheduled?: ScheduledEnvelope;
    }
  | { error: string };

/** Map the camelCase TS fields to the Tauri command's snake_case parameters. */
function snakeOpts(opts: SocialAdapterOpts | undefined) {
  if (!opts) return undefined;
  return {
    spBinary: opts.spBinary,
    postizBaseUrl: opts.postizBaseUrl,
    postizApiKeyEnv: opts.postizApiKeyEnv,
    postizAllowRemoteOnly: opts.postizAllowRemoteOnly ?? false,
  };
}

// ---------------------------------------------------------------------------
// probe -- "is the user's machine ready for this backend?"
// ---------------------------------------------------------------------------

export type ProbeSocialBackendResult = {
  backend: SocialBackend;
  /** SocialAvailability envelope from social-core, suitable for pill state. */
  availability: SocialAvailability;
};

/**
 * Ask the Node sidecar whether `backend`'s adapter is usable on the user's
 * machine right now (sp CLI installed, Postiz reachable, etc).
 *
 * Throws when the IPC roundtrip itself fails (sidecar crash, parse error).
 * A successful response that reports the backend as unavailable returns
 * `{ availability: { available: false, reason } }` -- callers render that
 * as the "not-configured" pill state.
 */
export async function probeSocialBackend(
  backend: SocialBackend,
  opts?: SocialAdapterOpts,
): Promise<ProbeSocialBackendResult> {
  const raw = await invoke<RawProbe>("social_probe_backend", {
    backend,
    opts: snakeOpts(opts),
  });
  if ("error" in raw) {
    throw new Error(`social_probe_backend failed: ${raw.error}`);
  }
  return {
    backend: raw.backend,
    availability: {
      available: raw.available,
      ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// login-state -- "which platforms have a live session right now?"
// ---------------------------------------------------------------------------

export type SocialLoginStateResult = {
  backend: SocialBackend;
  state: SocialLoginState;
};

/**
 * Per-platform login state. `social-poster` returns the cookies it has
 * cached under ~/.config/social-poster/; `postiz` lists the integrations
 * connected on the server. Empty map = "unknown" (the UI renders every
 * platform as "Not connected" and prompts the user to log in / configure).
 */
export async function socialLoginState(
  backend: SocialBackend,
  opts?: SocialAdapterOpts,
): Promise<SocialLoginStateResult> {
  const raw = await invoke<RawLoginState>("social_login_state", {
    backend,
    opts: snakeOpts(opts),
  });
  if ("error" in raw) {
    throw new Error(`social_login_state failed: ${raw.error}`);
  }
  // Defensive cast: the CLI only emits the SocialLoginState enum values for
  // valid platforms; anything else is dropped here so we don't have to widen
  // the public SocialLoginState type.
  const state: SocialLoginState = {};
  for (const [platform, value] of Object.entries(raw.state)) {
    if (value === "logged_in" || value === "logged_out" || value === "unknown") {
      // The platform key is opaque on the Tauri side. We let the SocialPlatform
      // enum filter happen at consumer time.
      (state as Record<string, string>)[platform] = value;
    }
  }
  return { backend: raw.backend, state };
}

// ---------------------------------------------------------------------------
// post -- the actual send
// ---------------------------------------------------------------------------

export type RunSocialPostOpts = {
  /** The composed SocialPost (validated by the CLI via parseSocialPost). */
  payload: SocialPost;
  /** Backend to dispatch to. Defaults to "social-poster" per spec sec 3. */
  backend?: SocialBackend;
  /**
   * Venture root. When provided the CLI persists the SocialResult to
   * <root>/13_social/posts/. Omitting it makes the call return the result
   * without writing anywhere -- useful for dry-run / preview surfaces.
   */
  ventureRoot?: string;
  adapter?: SocialAdapterOpts;
};

export type RunSocialPostResult = {
  backend: SocialBackend;
  result: SocialResult;
  /** Absolute path of the persisted result file when `ventureRoot` was set. */
  resultPath?: string;
  /**
   * Set when the CLI queued the post for later instead of firing now
   * (slice 9 of the SOCIAL-MODULE follow-up arc). Surface this to the
   * user so they know nothing has shipped yet.
   */
  scheduled?: {
    fireAt: string;
    queuePath: string;
    /** Shell-quoted command to wire into an OS scheduler. */
    fireCommand: string;
  };
};

/**
 * Send the payload via the configured backend. Re-parses the response with
 * parseSocialResult so callers always work against the social-core zod
 * schema (no raw `unknown` leakage into the React tree).
 */
export async function runSocialPost(
  opts: RunSocialPostOpts,
): Promise<RunSocialPostResult> {
  const backend: SocialBackend = opts.backend ?? "social-poster";
  const raw = await invoke<RawPost>("social_post", {
    payload: opts.payload,
    backend,
    ventureRoot: opts.ventureRoot,
    opts: snakeOpts(opts.adapter),
  });
  if ("error" in raw) {
    throw new Error(`social_post failed: ${raw.error}`);
  }
  return {
    backend: raw.backend,
    result: parseSocialResult(raw.result),
    ...(raw.resultPath !== undefined ? { resultPath: raw.resultPath } : {}),
    ...(raw.scheduled !== undefined ? { scheduled: raw.scheduled } : {}),
  };
}

// ---------------------------------------------------------------------------
// open the posts directory in the OS file manager
// ---------------------------------------------------------------------------

/**
 * Ask the OS to open <ventureRoot>/13_social/posts/ in the native file
 * manager. Creates the directory if it doesn't exist yet so the user lands
 * in a real folder.
 */
export async function openSocialPostLog(ventureRoot: string): Promise<void> {
  await invoke<void>("social_open_post_log", { ventureRoot });
}
