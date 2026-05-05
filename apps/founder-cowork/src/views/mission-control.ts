import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_REGISTRY, type AgentId, listAgents } from "@founder-os/agent-registry";
import { generateRunId } from "@founder-os/handoff-contract";
import { dispatchBundle } from "@founder-os/handoff-vscode";
import type {
  AccountSaveInput,
  AccountSummary,
  AccountsListResponse,
  AgentHealthMap,
  AgentSummary,
  HostToWebviewMessage,
  InitState,
  SessionSummary,
  TruthRunResponse,
  WebviewToHostMessage,
} from "@founder-os/mission-control-protocol";
import { MC_PROTOCOL_VERSION } from "@founder-os/mission-control-protocol";
import * as vscode from "vscode";
import * as git from "../lib/git.js";
import * as memoryLib from "../lib/memory.js";
import * as ollama from "../lib/ollama.js";
import * as skillsLib from "../lib/skills.js";
import * as taskFlow from "../lib/task-flow.js";
import * as vaultLib from "../lib/vault.js";
import { RUNNERS } from "../runners/all-runners.js";

export type { AgentHealthMap } from "@founder-os/mission-control-protocol";

const MC_UI_INDEX_REL = path.join(
  "..",
  "..",
  "..",
  "packages",
  "mission-control-ui",
  "dist",
  "index.html"
);

let panel: vscode.WebviewPanel | null = null;

export interface MissionControlBindings {
  spawnSession: (agentId: AgentId, prompt: string, branchSuffix?: string) => Promise<void>;
  orchestrate: (pmAgentId: AgentId, executorAgentId: AgentId, goal: string) => Promise<void>;
  showSession: (sessionId: string) => Promise<void>;
  killSession: (sessionId: string) => Promise<void>;
  rerunPreflight: () => Promise<AgentHealthMap>;
  pickVentureRoot: () => Promise<string | null>;
  listSessions: () => SessionSummary[];
  getVentureRoot: () => string | null;
  getExtensionVersion: () => string;
  // Phase 3.2 — accounts
  listAccounts: () => AccountsListResponse;
  saveAccount: (input: AccountSaveInput) => Promise<AccountSummary>;
  deleteAccount: (agentId: AgentId, id: string) => Promise<void>;
  setActiveAccount: (agentId: AgentId, id: string | null) => Promise<void>;
}

let bindings: MissionControlBindings | null = null;

export function setMissionControlBindings(b: MissionControlBindings): void {
  bindings = b;
}

export function openMissionControl(
  context: vscode.ExtensionContext,
  health: AgentHealthMap = {}
): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    void postInit(panel, health);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    "founderCowork.missionControl",
    "Mission Control",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(uiBundleDir(context)),
        vscode.Uri.file(context.extensionPath),
      ],
    }
  );

  panel.webview.html = renderHtml(context, panel.webview, health);

  panel.webview.onDidReceiveMessage((m: WebviewToHostMessage) =>
    // biome-ignore lint/style/noNonNullAssertion: value asserted non-null by surrounding logic
    handleWebviewMessage(m, panel!, health, context)
  );

  panel.onDidDispose(() => {
    panel = null;
  });
}

export function postInit(p: vscode.WebviewPanel, health: AgentHealthMap): void {
  const init: InitState = {
    protocolVersion: MC_PROTOCOL_VERSION,
    extensionVersion: bindings?.getExtensionVersion() ?? "0.3.0",
    agents: listAgents().map(toSummary),
    agentHealth: health,
    sessions: bindings?.listSessions() ?? [],
    ventureRoot: bindings?.getVentureRoot() ?? null,
  };
  send(p, { type: "init", state: init });
}

export function postSessionStarted(session: SessionSummary): void {
  if (!panel) return;
  send(panel, { type: "session:started", session });
}

export function postSessionExited(sessionId: string, exitCode: number): void {
  if (!panel) return;
  send(panel, { type: "session:exited", sessionId, exitCode });
}

export function postSessionsUpdate(sessions: SessionSummary[]): void {
  if (!panel) return;
  send(panel, { type: "sessions:update", sessions });
}

export function postAgentHealth(health: AgentHealthMap): void {
  if (!panel) return;
  send(panel, { type: "agents:health", health });
}

export function postVentureRoot(ventureRoot: string | null): void {
  if (!panel) return;
  send(panel, { type: "ventureRoot:changed", ventureRoot });
}

function send(p: vscode.WebviewPanel, m: HostToWebviewMessage): void {
  void p.webview.postMessage(m);
}

function reply(p: vscode.WebviewPanel, requestId: string, ok: true, result: unknown): void;
function reply(p: vscode.WebviewPanel, requestId: string, ok: false, error: string): void;
function reply(p: vscode.WebviewPanel, requestId: string, ok: boolean, payload: unknown): void {
  if (ok) {
    send(p, { type: "response", requestId, ok: true, result: payload });
  } else {
    send(p, { type: "response", requestId, ok: false, error: String(payload) });
  }
}

function skillScanInput(context: vscode.ExtensionContext): skillsLib.SkillScanInput {
  return {
    workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
    userStoragePath: context.globalStorageUri.fsPath,
    extensionPath: context.extensionPath,
  };
}

function buildExplainPrompt(selection: string, question?: string): string {
  const ask =
    question?.trim() ||
    "Explain what this code/text does, line by line where useful, then give a short summary at the end.";
  return `You are the Founder Cowork Explain agent. ${ask}\n\nTARGET:\n\`\`\`\n${selection}\n\`\`\``;
}

async function handleWebviewMessage(
  m: WebviewToHostMessage,
  p: vscode.WebviewPanel,
  health: AgentHealthMap,
  context: vscode.ExtensionContext
): Promise<void> {
  try {
    switch (m.type) {
      case "ready":
      case "refresh:init":
        postInit(p, health);
        return;

      case "session:spawn":
        await bindings?.spawnSession(m.agentId, m.prompt, m.branchSuffix);
        if (m.requestId) reply(p, m.requestId, true, null);
        return;
      case "session:orchestrate":
        await bindings?.orchestrate(m.pmAgentId, m.executorAgentId, m.goal);
        if (m.requestId) reply(p, m.requestId, true, null);
        return;
      case "session:show":
        await bindings?.showSession(m.sessionId);
        if (m.requestId) reply(p, m.requestId, true, null);
        return;
      case "session:kill":
        await bindings?.killSession(m.sessionId);
        if (m.requestId) reply(p, m.requestId, true, null);
        return;

      case "agents:rerunPreflight": {
        const next = await bindings?.rerunPreflight();
        if (next) postAgentHealth(next);
        if (m.requestId) reply(p, m.requestId, true, next ?? {});
        return;
      }
      case "settings:open":
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          m.query ?? "founderCowork"
        );
        if (m.requestId) reply(p, m.requestId, true, null);
        return;

      case "ventureRoot:pick": {
        const next = await bindings?.pickVentureRoot();
        postVentureRoot(next ?? null);
        if (m.requestId) reply(p, m.requestId, true, next ?? null);
        return;
      }

      case "github:status": {
        const root = requireRepoRoot();
        const result = await git.status(root);
        if (m.requestId) reply(p, m.requestId, true, result);
        return;
      }
      case "github:createBranch": {
        const root = requireRepoRoot();
        const result = await git.createBranch(root, m.name);
        if (m.requestId) reply(p, m.requestId, true, result);
        return;
      }
      case "github:commitAndPush": {
        const root = requireRepoRoot();
        const remote = vscode.workspace
          .getConfiguration("founderCowork")
          .get<string>("github.remote", "origin");
        const result = await git.commitAndPush(root, m.message, remote);
        if (m.requestId) reply(p, m.requestId, true, result);
        return;
      }
      case "github:createPR": {
        const root = requireRepoRoot();
        const result = await git.createPR(root, m.title, m.body);
        if (m.requestId) reply(p, m.requestId, true, result);
        return;
      }

      case "ollama:listModels": {
        const baseUrl = vscode.workspace
          .getConfiguration("founderCowork")
          .get<string>("providers.ollama.baseUrl", "http://localhost:11434");
        const result = await ollama.listModels(baseUrl);
        if (m.requestId) reply(p, m.requestId, true, result);
        return;
      }
      case "ollama:run": {
        const baseUrl = vscode.workspace
          .getConfiguration("founderCowork")
          .get<string>("providers.ollama.baseUrl", "http://localhost:11434");
        const result = await ollama.generate(baseUrl, m.model, m.prompt);
        if (m.requestId) reply(p, m.requestId, true, result);
        return;
      }

      case "skills:list": {
        const list = skillsLib.listSkills(skillScanInput(context));
        if (m.requestId) reply(p, m.requestId, true, { skills: list });
        return;
      }
      case "skills:read": {
        const body = skillsLib.readSkill(skillScanInput(context), m.id, m.source);
        if (m.requestId) reply(p, m.requestId, true, body);
        return;
      }

      case "memory:list": {
        const root = requireRepoRoot();
        const entries = memoryLib.listMemory(root);
        if (m.requestId) reply(p, m.requestId, true, { entries });
        return;
      }
      case "memory:read": {
        const root = requireRepoRoot();
        const body = memoryLib.readMemory(root, m.id);
        if (m.requestId) reply(p, m.requestId, true, body);
        return;
      }
      case "memory:save": {
        const root = requireRepoRoot();
        const saved = memoryLib.saveMemory(root, m.entry);
        if (m.requestId) reply(p, m.requestId, true, saved);
        return;
      }
      case "memory:delete": {
        const root = requireRepoRoot();
        memoryLib.deleteMemory(root, m.id);
        if (m.requestId) reply(p, m.requestId, true, { ok: true });
        return;
      }
      case "memory:saveCurrent": {
        const root = requireRepoRoot();
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          throw new Error("No active editor to snapshot. Focus a file first.");
        }
        const fileName = path.basename(editor.document.fileName);
        const saved = memoryLib.saveMemory(root, {
          name: `Snapshot: ${fileName}`,
          description: `Saved from ${editor.document.fileName} at ${new Date().toISOString()}`,
          type: "reference",
          body: editor.document.getText(),
        });
        if (m.requestId) reply(p, m.requestId, true, saved);
        return;
      }

      case "vault:list": {
        const root = requireRepoRoot();
        const docs = vaultLib.listVault(root);
        if (m.requestId) reply(p, m.requestId, true, { docs });
        return;
      }
      case "vault:read": {
        const root = requireRepoRoot();
        const body = vaultLib.readVault(root, m.id);
        if (m.requestId) reply(p, m.requestId, true, body);
        return;
      }
      case "vault:save": {
        const root = requireRepoRoot();
        const saved = vaultLib.saveVault(root, m.doc);
        if (m.requestId) reply(p, m.requestId, true, saved);
        return;
      }
      case "vault:delete": {
        const root = requireRepoRoot();
        vaultLib.deleteVault(root, m.id);
        if (m.requestId) reply(p, m.requestId, true, { ok: true });
        return;
      }

      // Accounts (Phase 3.2)
      case "accounts:list": {
        const result = bindings?.listAccounts() ?? { byAgent: {}, active: {} };
        if (m.requestId) reply(p, m.requestId, true, result);
        return;
      }
      case "accounts:save": {
        const saved = await bindings?.saveAccount(m.input);
        if (m.requestId) reply(p, m.requestId, true, saved ?? null);
        return;
      }
      case "accounts:delete": {
        await bindings?.deleteAccount(m.agentId, m.id);
        if (m.requestId) reply(p, m.requestId, true, { ok: true });
        return;
      }
      case "accounts:setActive": {
        await bindings?.setActiveAccount(m.agentId, m.id);
        if (m.requestId) reply(p, m.requestId, true, { ok: true });
        return;
      }

      // Truth tab (Phase 1b.4) — constructs a GENERATE_TRUTH_LAYER bundle and
      // dispatches via the Phase 2 dispatcher. Reads TRUTH.md off disk to
      // return inline.
      case "truth:run": {
        const root = requireRepoRoot();
        const claudeBinary =
          vscode.workspace
            .getConfiguration("founderCowork")
            .get<string>("providers.claude.binaryName") ?? "claude";
        const ventureId = vscode.workspace
          .getConfiguration("founderCowork")
          .get<string>("ventureId", path.basename(root));
        const runId = generateRunId();
        const bundle = {
          runId,
          ventureId,
          type: "GENERATE_TRUTH_LAYER" as const,
          createdAt: new Date().toISOString(),
          ventureRoot: root,
          artifactRefs: [],
          payload: {
            target: m.target,
            scopeNotes: m.scopeNotes ?? "",
          },
          schemaVersion: 1 as const,
        };
        const result = await dispatchBundle(
          bundle,
          {
            ventureRoot: root,
            claudeBinary,
            onProgress: () => {
              /* swallow per-step */
            },
          },
          RUNNERS
        );
        // Attempt to read TRUTH.md to return inline.
        const truthPath = path.join(root, "TRUTH.md");
        let body: string | undefined;
        if (fs.existsSync(truthPath)) {
          try {
            body = fs.readFileSync(truthPath, "utf8");
          } catch {
            /* no-op */
          }
        }
        const response: TruthRunResponse = {
          runId: result.runId,
          status: result.status,
          summary: result.summary,
          error: result.error,
          producedArtifacts: result.producedArtifacts.map((a) => a.path),
          body,
          bodyPath: body ? "TRUTH.md" : undefined,
        };
        if (m.requestId) reply(p, m.requestId, true, response);
        return;
      }

      // Explain tab (Phase 1b.4) — spawns an agent (default Claude) with
      // the user's selection wrapped in an Explain prompt. Output streams
      // to a terminal pane and the session lands in the Sessions table.
      case "explain:run": {
        if (!m.selection.trim()) {
          throw new Error("Selection is empty. Paste some code or text first.");
        }
        const agentId = m.agentId ?? "claude";
        await bindings?.spawnSession(
          agentId,
          buildExplainPrompt(m.selection, m.question),
          "explain"
        );
        if (m.requestId) reply(p, m.requestId, true, null);
        return;
      }

      case "task:analyzeRepo": {
        const agentId = m.agentId ?? "claude";
        await bindings?.spawnSession(agentId, taskFlow.buildAnalyzePrompt(), "analyze");
        if (m.requestId) reply(p, m.requestId, true, null);
        return;
      }
      case "task:planTask": {
        const agentId = m.agentId ?? "claude";
        await bindings?.spawnSession(agentId, taskFlow.buildPlanPrompt(m.goal), "plan");
        if (m.requestId) reply(p, m.requestId, true, null);
        return;
      }
      case "task:executeTask": {
        await bindings?.spawnSession(m.executorAgentId, taskFlow.buildExecutePrompt(), "exec");
        if (m.requestId) reply(p, m.requestId, true, null);
        return;
      }
      case "task:reviewExecution": {
        const root = requireRepoRoot();
        const diff = taskFlow.gatherDiff(root);
        if (!diff) {
          throw new Error(
            "No diff to review. Make sure the executor produced changes vs the upstream branch."
          );
        }
        const agentId = m.agentId ?? "claude";
        await bindings?.spawnSession(agentId, taskFlow.buildReviewPrompt(diff), "review");
        if (m.requestId) reply(p, m.requestId, true, null);
        return;
      }
      case "task:approve": {
        const root = requireRepoRoot();
        const result = taskFlow.commitApproved(root);
        if (m.requestId) reply(p, m.requestId, true, result);
        send(p, {
          type: "toast",
          level: "info",
          message: `Approved -> ${result.commitSha.slice(0, 8)}`,
        });
        return;
      }
      case "task:requestRevision": {
        await bindings?.spawnSession(
          m.executorAgentId,
          taskFlow.buildRevisionPrompt(m.notes),
          "revise"
        );
        if (m.requestId) reply(p, m.requestId, true, null);
        return;
      }
      case "task:askGemini": {
        await bindings?.spawnSession("gemini", taskFlow.buildAskGeminiPrompt(m.question), "gem");
        if (m.requestId) reply(p, m.requestId, true, null);
        return;
      }
      case "task:askGeminiDiff": {
        const root = requireRepoRoot();
        const diff = taskFlow.gatherDiff(root);
        if (!diff) {
          throw new Error("No diff to send. Make a change first or push a branch upstream.");
        }
        await bindings?.spawnSession(
          "gemini",
          taskFlow.buildAskGeminiDiffPrompt(diff, m.question),
          "gem-diff"
        );
        if (m.requestId) reply(p, m.requestId, true, null);
        return;
      }
      case "stats:refresh": {
        const sessions = bindings?.listSessions() ?? [];
        const stats = taskFlow.summariseSessions(sessions);
        if (m.requestId) reply(p, m.requestId, true, stats);
        return;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if ("requestId" in m && m.requestId) {
      reply(p, m.requestId, false, msg);
    }
    send(p, { type: "toast", level: "error", message: msg });
  }
}

function toSummary(def: ReturnType<typeof listAgents>[number]): AgentSummary {
  return {
    id: def.id,
    label: def.label,
    icon: def.icon,
    authStyle: def.authStyle,
    promptInjection: def.promptInjection,
  };
}

void AGENT_REGISTRY;

function uiBundleDir(context: vscode.ExtensionContext): string {
  const packaged = path.join(context.extensionPath, "out", "ui");
  if (fs.existsSync(packaged)) return packaged;
  return path.join(context.extensionPath, MC_UI_INDEX_REL, "..");
}

function renderHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  _health: AgentHealthMap
): string {
  const dir = uiBundleDir(context);
  const indexPath = path.join(dir, "index.html");

  if (!fs.existsSync(indexPath)) {
    return fallbackHtml(
      `Mission Control UI bundle missing. Expected: ${indexPath}. Run \`pnpm --filter @founder-os/mission-control-ui build\` first, or run \`pnpm --filter founder-cowork build\` which chains both.`
    );
  }

  let html = fs.readFileSync(indexPath, "utf8");

  const nonce = makeNonce();
  const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}' 'unsafe-inline'; font-src ${webview.cspSource};`;

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`;
  html = html.replace(/<head>/, `<head>${cspMeta}`);

  html = html.replace(
    /<script(\s[^>]*)?>/g,
    (_match, attrs) => `<script${attrs || ""} nonce="${nonce}">`
  );

  return html;
}

function fallbackHtml(message: string): string {
  const safe = message.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return [
    '<!DOCTYPE html><html><head><meta charset="UTF-8" /><title>Mission Control</title>',
    "<style>body{font-family:sans-serif;padding:2em;color:#d4d4d4;background:#1e1e1e;} pre{background:rgba(255,255,255,0.05);padding:1em;border-radius:6px;}</style>",
    "</head><body><h1>Mission Control unavailable</h1><pre>",
    safe,
    "</pre></body></html>",
  ].join("");
}

function makeNonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function requireRepoRoot(): string {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    throw new Error("No folder open in VS Code. Open a git repository, then retry.");
  }
  return ws.uri.fsPath;
}
