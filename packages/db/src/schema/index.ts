import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Ventures table: lightweight metadata only. Canonical venture config
 * lives in venture.yaml on disk.
 */
export const ventures = sqliteTable(
  "ventures",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    stage: text("stage").notNull(),
    rootPath: text("root_path").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    slugIdx: index("ventures_slug_idx").on(t.slug),
    stageIdx: index("ventures_stage_idx").on(t.stage),
  })
);

/**
 * Artifacts index: filesystem is source of truth; this table is for fast queries.
 */
export const artifacts = sqliteTable(
  "artifacts",
  {
    artifactId: text("artifact_id").primaryKey(),
    ventureId: text("venture_id")
      .notNull()
      .references(() => ventures.id),
    type: text("type").notNull(),
    path: text("path").notNull(),
    hash: text("hash"),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    derivedFromJson: text("derived_from_json").notNull().default("[]"),
    tagsJson: text("tags_json").notNull().default("[]"),
  },
  (t) => ({
    ventureIdx: index("artifacts_venture_idx").on(t.ventureId),
    typeIdx: index("artifacts_type_idx").on(t.type),
  })
);

/**
 * Pipeline runs: one row per handoff bundle lifecycle.
 */
export const runs = sqliteTable(
  "runs",
  {
    runId: text("run_id").primaryKey(),
    ventureId: text("venture_id")
      .notNull()
      .references(() => ventures.id),
    type: text("type").notNull(),
    status: text("status").notNull(),
    summary: text("summary"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
  },
  (t) => ({
    ventureIdx: index("runs_venture_idx").on(t.ventureId),
    statusIdx: index("runs_status_idx").on(t.status),
  })
);

/**
 * Audit findings: joined to runs.
 */
export const auditFindings = sqliteTable(
  "audit_findings",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.runId),
    ventureId: text("venture_id").notNull(),
    ruleId: text("rule_id").notNull(),
    severity: text("severity").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    filePath: text("file_path"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    runIdx: index("findings_run_idx").on(t.runId),
    severityIdx: index("findings_severity_idx").on(t.severity),
  })
);

/**
 * Chat messages: venture-scoped. Full transcripts also live on disk as JSONL.
 */
export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    ventureId: text("venture_id")
      .notNull()
      .references(() => ventures.id),
    threadId: text("thread_id").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    threadIdx: index("chat_thread_idx").on(t.threadId),
  })
);

/**
 * Tasks: venture-scoped todo items; often created by pipeline steps (e.g. "file trademark").
 */
export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    ventureId: text("venture_id")
      .notNull()
      .references(() => ventures.id),
    title: text("title").notNull(),
    status: text("status").notNull(),
    stage: text("stage"),
    dueAt: text("due_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    ventureIdx: index("tasks_venture_idx").on(t.ventureId),
    statusIdx: index("tasks_status_idx").on(t.status),
  })
);

export type DbSchema = {
  ventures: typeof ventures;
  artifacts: typeof artifacts;
  runs: typeof runs;
  auditFindings: typeof auditFindings;
  chatMessages: typeof chatMessages;
  tasks: typeof tasks;
};
