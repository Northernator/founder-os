/**
 * SalesTab -- run the multi-agent sales pipeline against a prospect URL.
 *
 * The pipeline lives in @founder-os/sales-agents (client-safe barrel).
 * PDF generation is Node-only (pdfkit) so the desktop tab can't render
 * in-process; instead it invokes the Tauri sidecar `generate_sales_report`
 * which spawns the CLI report command via pnpm. This keeps the renderer
 * pure while delivering one-click PDF generation.
 *
 * UI: a collapsible "About" card explains the pipeline to first-time
 * users, then a Run card with URL input + button, then conditional
 * cards for the agent log and report artifacts.
 */

import type { Venture } from "@founder-os/domain";
import { runSalesPipeline, slugForUrl } from "@founder-os/sales-agents";
import type { FsAdapter, SalesMemory } from "@founder-os/sales-agents";
import { Button, Card } from "@founder-os/ui";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import { tauriFs } from "../../lib/pipeline-fs.js";
import { buildPipelineLlmCaller } from "../../lib/pipeline-llm.js";
import { pushToast } from "../../lib/toasts.js";
import { joinPath, openInFileManager } from "../../lib/venture-io.js";
import { SalesChatPanel } from "./SalesChatPanel.js";

type LogLevel = "info" | "ok" | "err";

type LogLine = {
  ts: number;
  level: LogLevel;
  text: string;
};

export function SalesTab({ venture }: { venture: Venture }) {
  const [url, setUrl] = useState("");
  const [running, setRunning] = useState(false);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [memoryPath, setMemoryPath] = useState<string | null>(null);
  const [memory, setMemory] = useState<SalesMemory | null>(null);
  const [pdfPath, setPdfPath] = useState<string | null>(null);

  // Load memory.json whenever memoryPath changes -- the Outreach Emails
  // card needs the parsed contents (the chat panel loads its own copy
  // independently; both reads are cheap + idempotent).
  useEffect(() => {
    let cancelled = false;
    if (!memoryPath) {
      setMemory(null);
      return;
    }
    (async () => {
      try {
        const exists = await tauriFs.exists(memoryPath);
        if (!exists) return;
        const raw = await tauriFs.readFile(memoryPath);
        if (cancelled) return;
        setMemory(JSON.parse(raw) as SalesMemory);
      } catch {
        if (!cancelled) setMemory(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [memoryPath]);

  function appendLog(level: LogLevel, text: string): void {
    setLog((prev) => [...prev, { ts: Date.now(), level, text }]);
  }

  async function handleRun(): Promise<void> {
    if (!url || running) return;
    setRunning(true);
    setLog([]);
    setMemoryPath(null);
    setPdfPath(null);

    try {
      const built = await buildPipelineLlmCaller({ ventureId: venture.id });
      if (!built) {
        pushToast({
          kind: "error",
          message: "No LLM provider configured -- pick one in Options.",
        });
        return;
      }

      const slug = slugForUrl(url);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const baseDir = joinPath(
        joinPath(joinPath(joinPath(venture.rootPath, ".founder"), "sales"), slug),
        stamp
      );
      const memPath = joinPath(baseDir, "memory.json");

      appendLog("info", `output: ${baseDir}`);

      const result = await runSalesPipeline({
        prospectUrl: url,
        memoryPath: memPath,
        fs: bridgeTauriFs(),
        callLlm: built.callLlm,
        onProgress: (e) => {
          if (e.phase === "start") {
            appendLog("info", `start: ${e.agent}`);
          } else {
            const ok = e.output?.status === "success";
            appendLog(
              ok ? "ok" : "err",
              ok ? `done:  ${e.agent}` : `fail:  ${e.agent} -- ${e.output?.error ?? "?"}`
            );
          }
        },
      });

      appendLog("ok", `pipeline complete in ${(result.durationMs / 1000).toFixed(1)}s`);
      setMemoryPath(memPath);
    } catch (err) {
      appendLog("err", `pipeline error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  }

  async function handleGeneratePdf(): Promise<void> {
    if (!memoryPath || generatingPdf) return;
    setGeneratingPdf(true);
    appendLog("info", "generating PDF via sidecar (pnpm --filter ... cli report)...");
    try {
      const result = await invoke<string>("generate_sales_report", {
        memoryPath,
        prospectUrl: url,
      });
      setPdfPath(result);
      appendLog("ok", `PDF written: ${result}`);
      pushToast({ kind: "success", message: "Sales report PDF generated" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog("err", `PDF gen failed: ${msg}`);
      pushToast({ kind: "error", message: `PDF gen failed: ${msg.slice(0, 120)}` });
    } finally {
      setGeneratingPdf(false);
    }
  }

  async function handleOpenPdf(): Promise<void> {
    if (!pdfPath) return;
    try {
      await openInFileManager(pdfPath);
    } catch (err) {
      pushToast({
        kind: "error",
        message: `Could not reveal PDF: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
        height: "100%",
        minHeight: 0,
        width: "100%",
        minWidth: 0,
        overflowY: "auto",
        overflowX: "hidden",
        boxSizing: "border-box",
        padding: "1rem",
      }}
    >
      <Card style={salesCardStyle}>
        <details open>
          <summary
            style={{
              cursor: "pointer",
              fontSize: "0.95rem",
              fontWeight: 600,
              userSelect: "none",
              padding: "0.25rem 0",
            }}
          >
            About the Sales Pipeline
          </summary>
          <div style={copyBlockStyle}>
            <h4 style={{ margin: "0.5rem 0 0.25rem 0" }}>What you put in</h4>
            <p style={{ margin: "0 0 0.75rem 0" }}>
              A company URL. That's it. Anything like <code>https://acme.com</code> or{" "}
              <code>https://stripe.com/pricing</code> works -- the pipeline only uses the domain to
              figure out who the company is, you don't need a special format.
            </p>

            <h4 style={{ margin: "0.5rem 0 0.25rem 0" }}>What the five agents do</h4>
            <ol style={{ margin: "0 0 0.5rem 1.25rem", padding: 0 }}>
              <li>
                <strong>Research</strong> -- Visits the URL, figures out who the company is
                (industry, size, products, recent news, what makes them different).
              </li>
              <li>
                <strong>BANT scoring</strong> -- Rates the prospect 1-5 on Budget, Authority, Need,
                Timeline. Combined into a 0-100 "fit score". Low scores are good -- they tell you
                not to waste time.
              </li>
              <li>
                <strong>Decision Makers</strong> -- Lists 3-5 roles (not specific people) you should
                target -- "VP of Engineering", "Head of Platform" -- plus tips on where to find them
                on LinkedIn.
              </li>
              <li>
                <strong>Competitive Intel</strong> -- Names the prospect's likely competitors and
                where you'd slot in against them.
              </li>
              <li>
                <strong>Outreach</strong> -- Writes a 5-email cold sequence specific to what the
                other agents found.
              </li>
            </ol>
            <p style={{ margin: "0.5rem 0 0.75rem 0", opacity: 0.8 }}>
              Agents 2-4 run in parallel after Research finishes; Outreach runs last because it
              consumes everything. End-to-end: ~30-60 seconds with a real LLM.
            </p>

            <h4 style={{ margin: "0.5rem 0 0.25rem 0" }}>What you get back</h4>
            <p style={{ margin: "0 0 0.5rem 0" }}>
              Two files in{" "}
              <code>
                &lt;your-venture&gt;/.founder/sales/&lt;company-slug&gt;/&lt;timestamp&gt;/
              </code>
              :
            </p>
            <ul style={{ margin: "0 0 0.5rem 1.25rem", padding: 0 }}>
              <li>
                <code>memory.json</code> -- Raw structured data from all 5 agents. Useful if you
                want to feed it into something else, or hand-edit before regenerating the PDF.
              </li>
              <li>
                <code>report.pdf</code> -- 6-page sales briefing: cover, company overview, BANT
                score with bar chart, decision makers, competitive analysis, outreach sequence with
                all 5 emails inline.
              </li>
            </ul>
          </div>
        </details>
      </Card>

      <Card style={salesCardStyle}>
        <h2 style={{ margin: "0 0 0.75rem 0" }}>Run Pipeline</h2>
        <p style={{ marginTop: 0, opacity: 0.8, fontSize: "0.9rem" }}>
          Paste a prospect URL. Outputs land under <code>.founder/sales/</code> in this venture.
        </p>
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
          <input
            type="url"
            placeholder="https://acme.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={running}
            style={{ flex: "1 1 16rem", minWidth: 0, padding: "0.5rem", fontSize: "0.95rem" }}
          />
          <Button onClick={handleRun} disabled={!url || running}>
            {running ? "Running..." : "Run Pipeline"}
          </Button>
        </div>
      </Card>

      {log.length > 0 && (
        <Card style={salesCardStyle}>
          <h3 style={{ margin: "0 0 0.5rem 0" }}>Agent Log</h3>
          <pre
            style={{
              fontFamily: "monospace",
              fontSize: "0.85rem",
              margin: 0,
              padding: "0.5rem",
              background: "rgba(0,0,0,0.04)",
              maxHeight: "16rem",
              overflowY: "auto",
              overflowX: "auto",
              maxWidth: "100%",
            }}
          >
            {log.map((l) => (
              <div
                key={`${l.ts}-${l.text}`}
                style={{
                  color:
                    l.level === "err"
                      ? "var(--danger, #b91c1c)"
                      : l.level === "ok"
                        ? "var(--success, #047857)"
                        : "inherit",
                }}
              >
                {`[${new Date(l.ts).toLocaleTimeString()}] ${l.text}`}
              </div>
            ))}
          </pre>
        </Card>
      )}

      {memoryPath && (
        <Card style={salesCardStyle}>
          <h3 style={{ margin: "0 0 0.5rem 0" }}>Report Artifacts</h3>
          <p style={pathLineStyle}>
            Memory: <code>{memoryPath}</code>
          </p>
          {pdfPath && (
            <p style={pathLineStyle}>
              PDF: <code>{pdfPath}</code>
            </p>
          )}
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
            <Button onClick={handleGeneratePdf} disabled={generatingPdf}>
              {generatingPdf ? "Generating..." : pdfPath ? "Regenerate PDF" : "Generate PDF"}
            </Button>
            {pdfPath && <Button onClick={handleOpenPdf}>Reveal in file manager</Button>}
          </div>
        </Card>
      )}

      {memory?.outreach?.emails?.length ? (
        <Card style={salesCardStyle}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "0.75rem",
              flexWrap: "wrap",
              marginBottom: "0.75rem",
            }}
          >
            <h3 style={{ margin: 0 }}>Outreach Emails ({memory.outreach.emails.length})</h3>
            <Button onClick={() => handleCopyAllEmails(memory?.outreach?.emails ?? [])}>
              Copy all
            </Button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {memory.outreach.emails.map((e, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: static list, order does not change
                key={`email-${i}`}
                style={{
                  border: "1px solid var(--border-subtle, #e2e8f0)",
                  borderRadius: "0.4rem",
                  padding: "0.75rem",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    gap: "0.5rem",
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: "0.95rem", minWidth: 0 }}>
                    {i + 1}. {e.subject}
                  </div>
                  <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                    <Button onClick={() => handleCopyEmail(e)}>Copy</Button>
                    <Button onClick={() => handleMailtoEmail(e)}>Open in mail</Button>
                  </div>
                </div>
                <pre
                  style={{
                    margin: "0.5rem 0 0 0",
                    fontFamily: "inherit",
                    fontSize: "0.85rem",
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    opacity: 0.85,
                  }}
                >
                  {e.body}
                </pre>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Card style={salesCardStyle}>
        <h3 style={{ margin: "0 0 0.5rem 0" }}>Follow-up Chat</h3>
        <p style={{ marginTop: 0, opacity: 0.8, fontSize: "0.9rem" }}>
          Ask follow-up questions about this prospect. History persists at{" "}
          <code>.founder/sales/chat.jsonl</code>.
        </p>
        <details style={{ marginTop: "0.5rem", fontSize: "0.9rem" }}>
          <summary
            style={{
              cursor: "pointer",
              fontWeight: 600,
              userSelect: "none",
              padding: "0.25rem 0",
            }}
          >
            What it can do -- example prompts
          </summary>
          <div style={{ marginTop: "0.5rem", lineHeight: 1.55 }}>
            <p style={{ margin: "0 0 0.5rem 0" }}>Try things like:</p>
            <ul style={{ margin: "0 0 0.5rem 1.25rem", padding: 0 }}>
              <li>"Make email 3 more direct -- they're CTO, not CMO."</li>
              <li>"What angle should we lead with given they just raised?"</li>
              <li>"Draft a one-page proposal based on this intel."</li>
              <li>"What weaknesses do you see in this BANT score?"</li>
              <li>"Suggest 2 more decision-maker roles I should target."</li>
            </ul>
            <p style={{ margin: "0.25rem 0 0 0", opacity: 0.85 }}>
              Each turn embeds the full intel in the system prompt, so the assistant can reference
              specific competitors, the fit score, or quote-back the drafted emails.
            </p>
          </div>
        </details>
        <div style={{ marginTop: "0.75rem", height: "min(32rem, 70vh)", minHeight: "22rem" }}>
          <SalesChatPanel venture={venture} memoryPath={memoryPath} />
        </div>
      </Card>
    </div>
  );
}

const salesCardStyle: React.CSSProperties = {
  flex: "0 0 auto",
  minWidth: 0,
  maxWidth: "100%",
};

const copyBlockStyle: React.CSSProperties = {
  marginTop: "0.75rem",
  fontSize: "0.9rem",
  lineHeight: 1.55,
  overflowWrap: "anywhere",
};

const pathLineStyle: React.CSSProperties = {
  marginTop: 0,
  fontSize: "0.9rem",
  overflowWrap: "anywhere",
};

/** Format a single email as plain-text "Subject: ...\n\n<body>". */
function formatEmail(e: { subject: string; body: string }): string {
  return `Subject: ${e.subject}\n\n${e.body}`;
}

function handleCopyEmail(e: { subject: string; body: string }): void {
  navigator.clipboard
    .writeText(formatEmail(e))
    .then(() => pushToast({ kind: "success", message: `Copied: ${e.subject.slice(0, 40)}` }))
    .catch(() => pushToast({ kind: "error", message: "Clipboard unavailable" }));
}

function handleCopyAllEmails(emails: { subject: string; body: string }[]): void {
  const joined = emails.map((e, i) => `--- Email ${i + 1} ---\n${formatEmail(e)}`).join("\n\n");
  navigator.clipboard
    .writeText(joined)
    .then(() => pushToast({ kind: "success", message: `Copied ${emails.length} emails` }))
    .catch(() => pushToast({ kind: "error", message: "Clipboard unavailable" }));
}

const MAILTO_LIMIT = 1900; // Outlook truncates around 2KB on Windows -- be conservative.

function handleMailtoEmail(e: { subject: string; body: string }): void {
  const subject = encodeURIComponent(e.subject);
  const body = encodeURIComponent(e.body);
  const href = `mailto:?subject=${subject}&body=${body}`;
  if (href.length > MAILTO_LIMIT) {
    pushToast({
      kind: "error",
      message:
        "Email too long for mailto -- copy to clipboard instead and paste into your mail client.",
    });
    return;
  }
  window.location.href = href;
}

/**
 * Bridge tauriFs (mkdir / exists / readFile / writeFile) to the
 * sales-agents FsAdapter (readJson / writeJson / ensureDir / pathJoin).
 */
function bridgeTauriFs(): FsAdapter {
  return {
    async readJson<T>(path: string): Promise<T | null> {
      try {
        const exists = await tauriFs.exists(path);
        if (!exists) return null;
        const raw = await tauriFs.readFile(path);
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    async writeJson(path: string, data: unknown): Promise<void> {
      const norm = path.replace(/\\/g, "/");
      const idx = norm.lastIndexOf("/");
      const dir = idx === -1 ? "" : norm.slice(0, idx);
      if (dir) await tauriFs.mkdir(dir);
      await tauriFs.writeFile(path, JSON.stringify(data, null, 2));
    },
    async ensureDir(path: string): Promise<void> {
      await tauriFs.mkdir(path);
    },
    pathJoin(...parts: string[]): string {
      return parts.reduce((acc, p) => (acc === "" ? p : joinPath(acc, p)), "");
    },
  };
}
