export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  level: LogLevel;
  event: string;
  payload?: Record<string, unknown>;
}

export interface Logger {
  debug: (event: string, payload?: Record<string, unknown>) => void;
  info: (event: string, payload?: Record<string, unknown>) => void;
  warn: (event: string, payload?: Record<string, unknown>) => void;
  error: (event: string, payload?: Record<string, unknown>) => void;
}

function emit(level: LogLevel, event: string, payload?: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), level, event, ...payload });
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

export function log(entry: LogEvent): void {
  emit(entry.level, entry.event, entry.payload);
}

export function createLogger(scope: string): Logger {
  const tag = (payload?: Record<string, unknown>): Record<string, unknown> => ({
    scope,
    ...(payload ?? {}),
  });
  return {
    debug: (event, payload) => emit("debug", event, tag(payload)),
    info: (event, payload) => emit("info", event, tag(payload)),
    warn: (event, payload) => emit("warn", event, tag(payload)),
    error: (event, payload) => emit("error", event, tag(payload)),
  };
}

/** Redact common secrets from arbitrary objects before logging. */
export function redact(value: unknown): unknown {
  const SENSITIVE = /api[_-]?key|secret|token|password|authorization/i;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE.test(k) ? "[redacted]" : redact(v);
  }
  return out;
}
