#!/usr/bin/env tsx
/**
 * social-providers Node sidecar CLI -- round 3 of the SOCIAL-MODULE-SPEC arc.
 *
 * The Tauri WebView can't import @founder-os/social-providers/node directly:
 * spawn.ts pulls in node:child_process and postiz-http.ts pulls in node:fetch
 * against potentially-remote hosts. Vite externalises both to stubs that throw
 * on access (the "blank screen on render" failure mode documented in the
 * media-providers PM-split memory). The crm-providers slice 5b CLI is the
 * established workaround -- we mirror it here.
 *
 * Subcommands (the Tauri side at apps/founder-desktop/src-tauri/src/social.rs
 * wraps each of these one-to-one):
 *
 *   social-providers probe       --backend <name> [--sp-binary <path>]
 *                                 [--postiz-base-url <url>]
 *                                 [--postiz-api-key-env <var>]
 *                                 [--postiz-allow-remote-only]
 *
 *   social-providers login-state --backend <name> [...same flags as probe]
 *
 *   social-providers post        --backend <name> --payload-file <abs>
 *                                 [--venture-root <abs>] [...same flags as probe]
 *
 * Output contract: every successful run writes ONE JSON line to stdout
 * matching the matching envelope shape below. Pnpm-noise + tsx-load chatter
 * goes to stderr. The Rust side picks the LAST non-empty stdout line as the
 * envelope (so trailing noise from pnpm itself doesn't corrupt parsing). On
 * uncaught failure the CLI exits non-zero with `{"error": "..."}` on stdout
 * so the WebView has a structured failure path.
 *
 * Why a CLI rather than a Tauri-side Rust port: SocialAdapter implementations
 * already exist in TypeScript and we want a single source of truth. Same logic
 * as the crm-providers slice 5b decision.
 */

import { existsSync, readFileSync } from "node:fs";

import {
  parseSocialPost,
  type PostizConfig,
  type SocialBackend,
} from "@founder-os/social-core";
import {
  createConfigOnlyProvider,
  createPostizProvider,
  createSocialPosterProvider,
  getSocialPostsDir,
  writeResult,
  writeScheduledPayload,
} from "./node.js";
import {
  flag,
  parseBackendFlag,
  parsePostizConfigFlags,
  required,
} from "./cli-args.js";

// ---------------------------------------------------------------------------
// Envelope shapes -- match these exactly in the Rust social.rs deserialisers.
// ---------------------------------------------------------------------------

type ProbeEnvelope = {
  backend: SocialBackend;
  available: boolean;
  reason?: string;
};

type LoginStateEnvelope = {
  backend: SocialBackend;
  /** Partial map per SocialPlatform -> "logged_in" | "logged_out" | "unknown". */
  state: Record<string, string>;
};

type PostEnvelope = {
  backend: SocialBackend;
  result: unknown; // serialised SocialResult; the WebView re-parses with zod
  resultPath?: string; // venture-relative path under 13_social/posts/ when persisted
  /**
   * When set, the CLI did NOT actually post -- the payload was queued
   * under <ventureRoot>/13_social/scheduled/ for later firing. Slice 9
   * fallback: social-poster doesn't support native scheduling but we
   * want a graceful path for `scheduleAt` users without forcing them
   * onto Postiz.
   */
  scheduled?: {
    fireAt: string;
    queuePath: string;
    /** Shell-quoted command the founder can register with their OS scheduler. */
    fireCommand: string;
  };
};

type ErrorEnvelope = { error: string };

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Strip the conventional `--` separator if pnpm/tsx forwarded it as a
  // literal argv entry. Same defensive filter as crm-providers cli.ts.
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "probe") {
      emit(await probeBackend(rest));
      return;
    }
    if (cmd === "login-state") {
      emit(await loginState(rest));
      return;
    }
    if (cmd === "post") {
      emit(await postPayload(rest));
      return;
    }
    printUsage();
    process.exit(cmd ? 1 : 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit<ErrorEnvelope>({ error: message });
    process.exit(1);
  }
}

function emit<T>(payload: T): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function printUsage(): void {
  process.stderr.write(
    [
      "social-providers CLI",
      "",
      "Usage:",
      "  social-providers probe       --backend <name> [...flags]",
      "  social-providers login-state --backend <name> [...flags]",
      "  social-providers post        --backend <name> --payload-file <abs>",
      "                               [--venture-root <abs>] [...flags]",
      "",
      "Backends: social-poster | postiz | config_only",
      "",
      "Flags:",
      "  --sp-binary <path>            social-poster CLI name/path (default 'sp')",
      "  --postiz-base-url <url>       Postiz API base URL",
      "  --postiz-api-key-env <var>    Env var holding the Postiz API key",
      "                                (default POSTIZ_API_KEY)",
      "  --postiz-allow-remote-only    Refuse non-local Postiz hosts",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Adapter factory shared by every subcommand
// ---------------------------------------------------------------------------

type AdapterFactoryArgs = {
  backend: SocialBackend;
  spBinary?: string;
  postizConfig: PostizConfig;
  ventureRoot?: string;
};

function buildAdapter(args: AdapterFactoryArgs) {
  switch (args.backend) {
    case "social-poster":
      return createSocialPosterProvider({
        binary: args.spBinary ?? "sp",
      });
    case "postiz":
      return createPostizProvider({
        config: args.postizConfig,
        env: process.env,
      });
    case "config_only": {
      // The config_only provider persists drafts under <venture>/13_social/.
      // The CLI may run probe/login-state without a venture root (the
      // WebView's pre-compose pill calls those), in which case we fall back
      // to the empty-string root -- writeDraft is never reached on those
      // paths.
      return createConfigOnlyProvider({
        ventureRoot: args.ventureRoot ?? "",
      });
    }
    default:
      throw new Error(`backend not supported by this CLI: ${args.backend}`);
  }
}

// parseBackendFlag + parsePostizConfigFlags moved to ./cli-args.ts so vitest
// can exercise them without triggering this file's top-level main() boot.

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

async function probeBackend(args: string[]): Promise<ProbeEnvelope> {
  const backend = parseBackendFlag(args);
  const adapter = buildAdapter({
    backend,
    spBinary: flag(args, "--sp-binary"),
    postizConfig: parsePostizConfigFlags(args),
    ventureRoot: flag(args, "--venture-root"),
  });
  const probe = await adapter.available();
  return {
    backend,
    available: probe.available,
    ...(probe.reason !== undefined ? { reason: probe.reason } : {}),
  };
}

// ---------------------------------------------------------------------------
// login-state
// ---------------------------------------------------------------------------

async function loginState(args: string[]): Promise<LoginStateEnvelope> {
  const backend = parseBackendFlag(args);
  const adapter = buildAdapter({
    backend,
    spBinary: flag(args, "--sp-binary"),
    postizConfig: parsePostizConfigFlags(args),
    ventureRoot: flag(args, "--venture-root"),
  });
  const state = await adapter.loginState();
  // Stringify undefined values out so the JSON line stays clean. Object.entries
  // on a Partial<Record<...>> widens the value type to unknown under --strict,
  // so we narrow explicitly before assignment.
  const out: Record<string, string> = {};
  for (const [platform, value] of Object.entries(state)) {
    if (typeof value === "string") out[platform] = value;
  }
  return { backend, state: out };
}

// ---------------------------------------------------------------------------
// post
// ---------------------------------------------------------------------------

async function postPayload(args: string[]): Promise<PostEnvelope> {
  const backend = parseBackendFlag(args);
  const payloadFile = required(flag(args, "--payload-file"), "--payload-file");
  const ventureRoot = flag(args, "--venture-root");
  if (!existsSync(payloadFile)) {
    throw new Error(`payload file does not exist: ${payloadFile}`);
  }
  const raw = JSON.parse(readFileSync(payloadFile, "utf8"));
  const payload = parseSocialPost(raw);

  // Slice 9: social-poster has no native scheduling. If the caller asked
  // for a future fire time, queue the payload to disk and return a
  // {scheduled} envelope instead of running the adapter. We only do this
  // for social-poster because postiz handles scheduleAt natively.
  if (
    payload.scheduleAt &&
    backend === "social-poster" &&
    ventureRoot &&
    existsSync(ventureRoot)
  ) {
    const fireAt = payload.scheduleAt;
    const now = Date.now();
    const fireMs = Date.parse(fireAt);
    // Tolerate "scheduleAt in the past by < 30s" -- racy clocks shouldn't
    // surprise the user into a queue when they expected an immediate post.
    if (!Number.isFinite(fireMs) || fireMs - now < 30_000) {
      // Fall through to immediate post.
    } else {
      const queuePath = await writeScheduledPayload(ventureRoot, payload);
      const fireCommand = `pnpm --filter @founder-os/social-providers cli -- post --backend ${backend} --payload-file ${JSON.stringify(queuePath)} --venture-root ${JSON.stringify(ventureRoot)}`;
      process.stderr.write(
        `[social-providers] queued scheduled post -> ${queuePath} (fire at ${fireAt})\n`,
      );
      return {
        backend,
        result: {
          ventureSlug: payload.ventureSlug,
          backend,
          postedAt: new Date().toISOString(),
          rows: payload.platforms.map((platform) => ({
            platform,
            success: false,
            error: `Scheduled for ${fireAt}. Re-run the CLI on the queue file when the time arrives.`,
            errorCode: "scheduled-not-supported" as const,
            timestamp: new Date().toISOString(),
          })),
          rawAdapterPayload: { queuePath, fireAt, queued: true },
        },
        scheduled: { fireAt, queuePath, fireCommand },
      };
    }
  }

  const adapter = buildAdapter({
    backend,
    spBinary: flag(args, "--sp-binary"),
    postizConfig: parsePostizConfigFlags(args),
    ventureRoot,
  });

  const result = await adapter.post(payload);

  // Persist under 13_social/posts/ when we have a venture root. Probe and
  // login-state never reach this code path.
  let resultPath: string | undefined;
  if (ventureRoot && existsSync(ventureRoot)) {
    try {
      resultPath = await writeResult(ventureRoot, result);
    } catch (err) {
      // Persistence failures are non-fatal -- the post itself already
      // happened. Surface the message so the desktop tab can show the
      // user a "result not saved" warning without invalidating the
      // post result row data.
      process.stderr.write(
        `[social-providers] writeResult failed: ${(err as Error).message}\n`,
      );
    }
  }

  // Also surface the posts dir on stderr so a desktop UI that wants to
  // jump there has it. Avoids a separate path-resolution command.
  if (ventureRoot) {
    try {
      process.stderr.write(
        `[social-providers] posts-dir: ${getSocialPostsDir(ventureRoot)}\n`,
      );
    } catch {
      // ignore -- helper is best-effort diagnostic.
    }
  }

  return {
    backend,
    result,
    ...(resultPath !== undefined ? { resultPath } : {}),
  };
}

// flag() + required() now live in ./cli-args.ts and are imported above.

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
});
