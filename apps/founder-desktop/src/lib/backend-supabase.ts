/**
 * Supabase Tauri-bridge wrappers for the BackendTab (slice 7 of the Supabase arc).
 *
 * Two Tauri commands:
 *   - backend_probe_supabase  validates credentials by hitting /auth/v1/health
 *     under the founder\'s project.
 *   - backend_save_supabase_credentials  writes the gitignored
 *     12_backend/supabase/.credentials.json on the user\'s machine.
 *
 * Both commands round-trip through the @founder-os/backend-providers CLI;
 * see backend.rs + cli.ts for the contract.
 */

import { invoke } from "@tauri-apps/api/core";

export type SupabaseProbeResult =
  | {
      available: true;
      projectUrl: string;
      version: string;
    }
  | { available: false; reason: string };

export type SupabaseSaveCredentialsResult =
  | { saved: true; credentialsPath: string }
  | { saved: false; reason: string };

export type ProbeSupabaseInput = {
  ventureRoot: string;
  projectUrl: string;
  anonKeyEnvVar?: string;
  serviceRoleKeyEnvVar?: string;
};

export async function probeSupabase(
  input: ProbeSupabaseInput,
): Promise<SupabaseProbeResult> {
  try {
    return await invoke<SupabaseProbeResult>("backend_probe_supabase", {
      ventureRoot: input.ventureRoot,
      projectUrl: input.projectUrl,
      anonKeyEnvVar: input.anonKeyEnvVar,
      serviceRoleKeyEnvVar: input.serviceRoleKeyEnvVar,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { available: false, reason: `Tauri command failed: ${message}` };
  }
}

export type SaveSupabaseCredentialsInput = {
  ventureRoot: string;
  projectUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  anonKeyEnvVar?: string;
  serviceRoleKeyEnvVar?: string;
};

export async function saveSupabaseCredentials(
  input: SaveSupabaseCredentialsInput,
): Promise<SupabaseSaveCredentialsResult> {
  try {
    return await invoke<SupabaseSaveCredentialsResult>(
      "backend_save_supabase_credentials",
      {
        ventureRoot: input.ventureRoot,
        projectUrl: input.projectUrl,
        anonKey: input.anonKey,
        serviceRoleKey: input.serviceRoleKey,
        anonKeyEnvVar: input.anonKeyEnvVar,
        serviceRoleKeyEnvVar: input.serviceRoleKeyEnvVar,
      },
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { saved: false, reason: `Tauri command failed: ${message}` };
  }
}
