/**
 * Wire-protocol types for the research-py FastAPI sidecar.
 *
 * Mirrors the pydantic models in services/research-py/src/research_py/
 * routes/research.py + jobs.py. When the Python side adds fields, copy
 * them here -- there is no codegen.
 *
 * NOTE: keep this file Node/browser-safe. No node:* imports, no
 * filesystem, no env reads. Same rule as @founder-os/prompt-master root
 * barrel.
 */

// ---------- jobs.py mirror ----------

export type JobStatus = "queued" | "running" | "done" | "error";

export type JobKind = "deep_research" | "competitor_scan" | "icp_synthesis";

/** GET /research/jobs/{id} response. ISO-8601 datetimes come over the
 *  wire as strings -- not auto-converted to Date here, callers can
 *  parse if they need a Date. */
export interface JobRecord {
  job_id: string;
  kind: JobKind;
  status: JobStatus;
  venture_slug: string;
  created_at: string;
  updated_at: string;
  progress_message: string;
  result: Record<string, unknown> | null;
  error: string | null;
}

// ---------- /research/deep ----------

export interface DeepResearchRequest {
  venture_slug: string;
  topic: string;
  /** 1-5. depth>=4 upgrades report_type to "deep" server-side. */
  depth?: number;
  /** Default "research_report". */
  report_type?: string;
}

export interface DeepResearchAcceptedResponse {
  job_id: string;
  status: JobStatus;
  venture_slug: string;
  poll: string;
}

/** Shape of JobRecord.result when a deep_research job finishes. */
export interface DeepResearchResult {
  venture_slug: string;
  output_path: string;
  sources_path: string;
  summary_md_chars: number;
  sources_count: number;
  sources: string[];
}

// ---------- /research/competitors ----------

export interface CompetitorScanRequest {
  venture_slug: string;
  /** 1-20 URLs. */
  urls: string[];
}

export interface CompetitorScanAcceptedResponse {
  job_id: string;
  status: JobStatus;
  venture_slug: string;
  poll: string;
  competitor_count: number;
}

/** Per-competitor entry inside CompetitorScanResult.competitors. */
export interface CompetitorBreakdown {
  url: string;
  slug: string;
  landing: string | null;
  pricing: string | null;
  about: string | null;
  wrote_landing: boolean;
  wrote_pricing: boolean;
  wrote_about: boolean;
  pricing_rows: number;
  errors: string[];
}

/** Shape of JobRecord.result when a competitor_scan job finishes. */
export interface CompetitorScanResult {
  venture_slug: string;
  competitor_count: number;
  competitors: CompetitorBreakdown[];
  pricing_csv: string;
  pricing_rows_total: number;
}

// ---------- /research/jobs (list) ----------

export interface JobListResponse {
  jobs: JobRecord[];
}

// ---------- /health ----------

export interface HealthResponse {
  status: string;
  [k: string]: unknown;
}

// ---------- /research/icp ----------

export interface IcpRequest {
  venture_slug: string;
}

export interface IcpAcceptedResponse {
  job_id: string;
  status: JobStatus;
  venture_slug: string;
  poll: string;
}

/** One persona inside the ICP. Mirrors @founder-os/domain PersonaSchema
 *  (camelCase) so the YAML payload drops directly into the spec stage. */
export interface IcpPersonaSummary {
  id: string;
  name: string;
  primaryGoal: string;
}

/** Shape of JobRecord.result when an icp_synthesis job finishes.
 *  The full personas (with description + painPoints) live in icp.yaml on
 *  disk -- only the lightweight summary is returned over the wire. */
export interface IcpResult {
  venture_slug: string;
  yaml_path: string;
  md_path: string;
  personas_count: number;
  summary_chars: number;
  input_count: number;
  personas: IcpPersonaSummary[];
}
