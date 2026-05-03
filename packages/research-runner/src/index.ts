/**
 * @founder-os/research-runner -- TypeScript client for the
 * services/research-py FastAPI sidecar.
 *
 * This barrel is browser/Node/Tauri-safe -- no node:* imports. Same
 * client-safety contract as the @founder-os/prompt-master root barrel.
 */
export { ResearchClient, ResearchClientError } from "./client.js";
export type { ResearchClientOptions } from "./client.js";
export { pollJob } from "./poll.js";
export type { PollJobOptions, PollJobOutcome } from "./poll.js";
export type {
  CompetitorBreakdown,
  CompetitorScanAcceptedResponse,
  CompetitorScanRequest,
  CompetitorScanResult,
  DeepResearchAcceptedResponse,
  DeepResearchRequest,
  DeepResearchResult,
  HealthResponse,
  IcpAcceptedResponse,
  IcpPersonaSummary,
  IcpRequest,
  IcpResult,
  JobKind,
  JobListResponse,
  JobRecord,
  JobStatus,
} from "./types.js";
