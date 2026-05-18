/**
 * Pure argv-parsing helpers for the social-providers CLI.
 *
 * Extracted from cli.ts so vitest can import + test these without
 * triggering cli.ts's side effects (top-level main() invocation, stdout
 * writes, process.exit). Mirrors the crm-providers cli-args.ts split.
 *
 * Slice 7 of the SOCIAL-MODULE follow-up arc.
 */

import type { PostizConfig, SocialBackend } from "@founder-os/social-core";

/**
 * Pull the value following `name` out of an argv array. Returns undefined
 * if `name` is missing or the next argv entry starts with `--` (meaning
 * the user wrote `--foo --bar` and forgot the value).
 */
export function flag(args: ReadonlyArray<string>, name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

/**
 * Throw a uniform "missing required argument" error when a flag the
 * caller declared mandatory came back undefined.
 */
export function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`missing required argument ${name}`);
  }
  return value;
}

/**
 * Parse the --backend flag into a typed SocialBackend. Whitelist
 * matches the CLI's supported set -- BrightBean / TryPost are stub-only
 * in slice 2 and never surface via the CLI.
 */
export function parseBackendFlag(args: ReadonlyArray<string>): SocialBackend {
  const raw = required(flag(args, "--backend"), "--backend");
  if (raw === "social-poster" || raw === "postiz" || raw === "config_only") {
    return raw;
  }
  throw new Error(`unsupported backend: ${raw}`);
}

/**
 * Build a PostizConfig from the postiz-specific flags. Empty baseUrl is
 * tolerated (the Postiz provider will surface a clearer error on
 * post()); apiKeyEnvVar falls back to POSTIZ_API_KEY when absent.
 */
export function parsePostizConfigFlags(args: ReadonlyArray<string>): PostizConfig {
  return {
    baseUrl: flag(args, "--postiz-base-url") ?? "",
    apiKeyEnvVar: flag(args, "--postiz-api-key-env") ?? "POSTIZ_API_KEY",
    allowRemoteOnly: args.includes("--postiz-allow-remote-only"),
  };
}
