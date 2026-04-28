import * as child_process from "node:child_process";
import {
  acceptBundle,
  consumeInboxFile,
  dispatchBundle,
  makeFailureResult,
  watchInbox,
  writeProgress,
  writeResult,
} from "@founder-os/handoff-vscode";
import { createLogger } from "@founder-os/logger";
import { setTransport } from "@founder-os/prompt-master";
import { createClaudeCliTransport, installNodeBackends } from "@founder-os/prompt-master/node";
import * as vscode from "vscode";

// Wire the Node-only cache + telemetry backends once at extension load. Idempotent.
installNodeBackends();
import {
  type Account,
  AccountManager,
  type AccountWithSecrets,
  FsAccountStore,
  makeAccount,
} from "@founder-os/agent-accounts";
import {
  AGENT_REGISTRY,
  type AgentDefinition,
  type AgentId,
  getAgent,
  listAgents,
} from "@founder-os/agent-registry";
import { AgentRunner } from "@founder-os/agent-runner";
import type { HandoffBundle } from "@founder-os/handoff-contract";
import type {
  AccountSaveInput,
  AccountSummary,
  AccountsListResponse,
  SessionSummary,
} from "@founder-os/mission-control-protocol";
import { WorktreeManager } from "@founder-os/worktree-manager";
import { loadNodePty } from "./lib/pty-loader.js";
import { createSessionTerminal } from "./lib/session-terminal.js";
import { RUNNERS } from "./runners/all-runners.js";
import {
  type AgentHealthMap,
  openMissionControl,
  postAgentHealth,
  postSessionExited,
  postSessionStarted,
  postSessionsUpdate,
  postVentureRoot,
  setMissionControlBindings,
} from "./views/mission-control.js";
import { type SessionEntry, SessionTreeProvider } from "./views/session-tree.js";
import { StatusTreeProvider } from "./views/status-tree.js";

const log = createLogger("founder-cowork");
const FIRST_OPEN_KEY = "founderCowork.hasSeenMissionControl";
const ACTIVE_ACCOUNTS_KEY = "founderCowork.activeAccounts";

let extensionContext: vscode.ExtensionContext | null = null;
let unsubscribeInbox: (() => void) | null = null;
let statusProvider: StatusTreeProvider | null = null;
let sessionProvider: SessionTreeProvider | null = null;

let agentRunner: AgentRunner | null = null;
function getRunner(): AgentRunner {
  if (!agentRunner) {
    agentRunner = new AgentRunner({ loadPty: loadNodePty });
  }
  return agentRunner;
}

let accountManager: AccountManager | null = null;
function getAccountManager(context: vscode.ExtensionContext): AccountManager {
  if (!accountManager) {
    const store = new FsAccountStore({
      storageRoot: context.globalStorageUri.fsPath,
    });
    accountManager = new AccountManager({ store });
  }
  return accountManager;
}

let agentHealth: AgentHealthMap = {};

// ──────────────────────────────────────────────
// Active-account helpers (per-agent, persisted in globalState)
// ──────────────────────────────────────────────

type ActiveAccountMap = Partial<Record<AgentId, string | null>>;

function readActiveAccounts(context: vscode.ExtensionContext): ActiveAccountMap {
  return context.globalState.get<ActiveAccountMap>(ACTIVE_ACCOUNTS_KEY, {});
}

async function writeActiveAccount(
  context: vscode.ExtensionContext,
  agentId: AgentId,
  id: string | null
): Promise<void> {
  const cur = readActiveAccounts(context);
  cur[agentId] = id;
  await context.globalState.update(ACTIVE_ACCOUNTS_KEY, cur);
}

function getActiveAccountId(
  context: vscode.ExtensionContext,
  agentId: AgentId
): string | undefined {
  const map = readActiveAccounts(context);
  return map[agentId] ?? undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  log.info("Founder Cowork activating...");
  extensionContext = context;

  // Wire up Prompt Master via the Claude CLI subprocess - no separate API
  // key needed. Uses whatever auth the CLI itself has (OAuth from
  // `claude login`, subscription mode, etc). If the binary isn't on PATH,
  // optimize() falls back to identity.
  try {
    const claudeBin =
      vscode.workspace
        .getConfiguration("founderCowork")
        .get<string>("providers.claude.binaryName") ?? "claude";
    setTransport(
      createClaudeCliTransport({
        binary: claudeBin,
        extraArgs: ["--model", "claude-haiku-4-5-20251001"],
      })
    );
    log.info("prompt-master: claude-cli transport registered (uses CLI auth)");
  } catch (err) {
    log.warn("prompt-master: transport setup failed (" + String(err) + "), falling back to no-op");
  }

  // Ensure globalStorage exists (FsAccountStore uses it).
  void vscode.workspace.fs.createDirectory(context.globalStorageUri).then(
    () => {},
    () => {}
  );

  statusProvider = new StatusTreeProvider();
  sessionProvider = new SessionTreeProvider();
  vscode.window.registerTreeDataProvider("founderCowork.status", statusProvider);
  vscode.window.registerTreeDataProvider("founderCowork.sessions", sessionProvider);

  setMissionControlBindings({
    spawnSession: async (agentId, prompt, branchSuffix) => {
      const def = getAgent(agentId);
      await spawnSession(def, prompt, branchSuffix ? { branchSuffix } : {}, context);
    },
    orchestrate: async (pmId, execId, goal) => {
      const pm = getAgent(pmId);
      const ex = getAgent(execId);
      await runOrchestration(pm, ex, goal, context);
    },
    showSession: async (sessionId) => {
      const e = sessionProvider?.get(sessionId);
      e?.terminal.show(false);
    },
    killSession: async (sessionId) => {
      const e = sessionProvider?.get(sessionId);
      if (!e) return;
      try {
        e.session.kill();
      } catch {
        /* no-op */
      }
      try {
        e.disposeTerminal();
      } catch {
        /* no-op */
      }
      try {
        e.terminal.dispose();
      } catch {
        /* no-op */
      }
      sessionProvider?.update(e.id, { status: "killed" });
      pushSessionsUpdate();
    },
    rerunPreflight: async () => {
      agentHealth = await runPreflight();
      return agentHealth;
    },
    pickVentureRoot: async () => {
      const result = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectMany: false,
        title: "Select Founder OS Venture Root Folder",
      });
      if (!result?.[0]) return null;
      const p = result[0].fsPath;
      await vscode.workspace
        .getConfiguration("founderCowork")
        .update("ventureRoot", p, vscode.ConfigurationTarget.Global);
      return p;
    },
    listSessions: () => (sessionProvider?.all() ?? []).map(toSummary),
    getVentureRoot: () =>
      vscode.workspace.getConfiguration("founderCowork").get<string>("ventureRoot") ?? null,
    getExtensionVersion: () => {
      const pkg = context.extension?.packageJSON as { version?: string } | undefined;
      return pkg?.version ?? "0.3.0";
    },

    // Phase 3.2 — accounts CRUD
    listAccounts: () => collectAccounts(context),
    saveAccount: async (input) => saveAccount(context, input),
    deleteAccount: async (agentId, id) => {
      getAccountManager(context).delete(agentId, id);
      const active = getActiveAccountId(context, agentId);
      if (active === id) {
        await writeActiveAccount(context, agentId, null);
      }
    },
    setActiveAccount: async (agentId, id) => {
      await writeActiveAccount(context, agentId, id);
    },
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("founderCowork.openMissionControl", () =>
      openMissionControl(context, agentHealth)
    ),
    vscode.commands.registerCommand("founderCowork.newSession", () => cmdNewSession(context)),
    vscode.commands.registerCommand("founderCowork.orchestrate", () => cmdOrchestrate(context)),
    vscode.commands.registerCommand("founderCowork.showSession", cmdShowSession),
    vscode.commands.registerCommand("founderCowork.killSession", cmdKillSession),
    vscode.commands.registerCommand("founderCowork.pickVentureRoot", cmdPickVentureRoot),
    vscode.commands.registerCommand("founderCowork.showStatus", () => statusProvider?.refresh())
  );

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((term) => {
      const entry = sessionProvider?.all().find((s) => s.terminal === term);
      if (entry) {
        try {
          entry.session.kill();
        } catch {
          /* no-op */
        }
        try {
          entry.disposeTerminal();
        } catch {
          /* no-op */
        }
        sessionProvider?.update(entry.id, { status: "exited" });
        pushSessionsUpdate();
      }
    })
  );

  const config = vscode.workspace.getConfiguration("founderCowork");
  const ventureRoot = config.get<string>("ventureRoot");
  const autoWatch = config.get<boolean>("autoWatch", true);

  if (ventureRoot && autoWatch) {
    startWatching(ventureRoot, context);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("founderCowork.ventureRoot")) {
        const next = vscode.workspace.getConfiguration("founderCowork").get<string>("ventureRoot");
        postVentureRoot(next ?? null);
      }
      if (
        e.affectsConfiguration("founderCowork.ventureRoot") ||
        e.affectsConfiguration("founderCowork.autoWatch")
      ) {
        restartWatch(context);
      }
    })
  );

  void runPreflight().then((h) => {
    agentHealth = h;
    log.info(
      "Preflight: " +
        Object.entries(h)
          .map(([k, v]) => k + "=" + (v.healthy ? "ok" : "missing"))
          .join(", ")
    );
    postAgentHealth(h);
  });

  const agentCount = listAgents().length;
  log.info("Founder Cowork activated (" + agentCount + " agents)");

  const hasSeen = context.globalState.get<boolean>(FIRST_OPEN_KEY, false);
  if (!hasSeen) {
    void context.globalState.update(FIRST_OPEN_KEY, true);
    setTimeout(() => openMissionControl(context, agentHealth), 500);
  } else {
    void vscode.window
      .showInformationMessage(
        "Founder Cowork ready (" + agentCount + " agents registered)",
        "Open Mission Control"
      )
      .then((pick) => {
        if (pick === "Open Mission Control") openMissionControl(context, agentHealth);
      });
  }
}

export function deactivate(): void {
  unsubscribeInbox?.();
  for (const s of sessionProvider?.all() ?? []) {
    try {
      s.session.kill();
    } catch {
      /* no-op */
    }
    try {
      s.disposeTerminal();
    } catch {
      /* no-op */
    }
    try {
      s.terminal.dispose();
    } catch {
      /* no-op */
    }
  }
  log.info("Founder Cowork deactivated");
}

// ──────────────────────────────────────────────
// Account helpers
// ──────────────────────────────────────────────

function collectAccounts(context: vscode.ExtensionContext): AccountsListResponse {
  const mgr = getAccountManager(context);
  const byAgent: Partial<Record<AgentId, AccountSummary[]>> = {};
  for (const def of listAgents()) {
    if (def.authStyle !== "managed-account") continue;
    byAgent[def.id] = mgr.list(def.id).map(toAccountSummary);
  }
  return { byAgent, active: readActiveAccounts(context) };
}

function toAccountSummary(a: Account): AccountSummary {
  return {
    id: a.id,
    agentId: a.agentId,
    label: a.label,
    notes: a.notes,
    createdAt: a.createdAt,
    source: a.source,
  };
}

async function saveAccount(
  context: vscode.ExtensionContext,
  input: AccountSaveInput
): Promise<AccountSummary> {
  const mgr = getAccountManager(context);
  const id = input.id?.trim() || idFromLabel(input.label);
  const acc: AccountWithSecrets = {
    ...makeAccount({
      id,
      agentId: input.agentId,
      label: input.label,
      notes: input.notes,
      source: input.source ?? "imported",
    }),
    authJson: input.authJson,
  };
  const saved = mgr.save(acc);
  return toAccountSummary(saved);
}

function idFromLabel(label: string): string {
  const slug = label
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .slice(0, 64);
  return slug || "account-" + Date.now().toString(36);
}

// ──────────────────────────────────────────────
// Preflight health check
// ──────────────────────────────────────────────

async function runPreflight(): Promise<AgentHealthMap> {
  const results: AgentHealthMap = {};
  const probes = listAgents().map(async (def) => {
    try {
      const healthy = await probeBinary(def.detectCmd);
      results[def.id] = healthy
        ? { healthy: true }
        : { healthy: false, hint: "`" + def.detectCmd + "` not found on PATH" };
    } catch (e) {
      results[def.id] = {
        healthy: false,
        hint: e instanceof Error ? e.message : String(e),
      };
    }
  });
  await Promise.all(probes);
  return results;
}

function probeBinary(cmd: string): Promise<boolean> {
  const isWin = process.platform === "win32";
  const probeCmd = isWin ? "where" : "which";
  return new Promise((resolve) => {
    const child = child_process.spawn(probeCmd, [cmd], {
      shell: false,
      windowsHide: true,
    });
    const to = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* no-op */
      }
      resolve(false);
    }, 3000);
    child.on("exit", (code) => {
      clearTimeout(to);
      resolve(code === 0);
    });
    child.on("error", () => {
      clearTimeout(to);
      resolve(false);
    });
  });
}

// ──────────────────────────────────────────────
// Session commands
// ──────────────────────────────────────────────

async function cmdNewSession(context: vscode.ExtensionContext): Promise<void> {
  const picked = await pickAgent("Select agent to spawn a session with");
  if (!picked) return;

  const prompt = await vscode.window.showInputBox({
    prompt: "Prompt for " + picked.label,
    placeHolder: "what should " + picked.label + " work on in this session?",
    ignoreFocusOut: true,
  });
  if (prompt === undefined) return;

  await spawnSession(picked, prompt, {}, context);
}

async function cmdOrchestrate(context: vscode.ExtensionContext): Promise<void> {
  const pm = await pickAgent("1/2 · PM agent (writes the plan to TASK.md)");
  if (!pm) return;
  const executor = await pickAgent("2/2 · Executor (reads TASK.md and implements it)");
  if (!executor) return;

  const goal = await vscode.window.showInputBox({
    prompt: "High-level goal for the orchestrated run",
    placeHolder: "e.g. 'add a dark mode toggle to the settings page'",
    ignoreFocusOut: true,
  });
  if (!goal) return;

  await runOrchestration(pm, executor, goal, context);
}

async function runOrchestration(
  pm: AgentDefinition,
  executor: AgentDefinition,
  goal: string,
  context: vscode.ExtensionContext
): Promise<void> {
  const pmPrompt =
    "You are the PM. Analyze the repo, then write a detailed TASK.md at the repo root " +
    "describing the work required to: " +
    goal +
    ". Include file-level guidance. Do not write code yet.";
  const execPrompt =
    "You are the executor. Read TASK.md at the repo root and implement what it describes. " +
    "Commit incrementally. Goal: " +
    goal;

  await spawnSession(pm, pmPrompt, { branchSuffix: "pm" }, context);
  await spawnSession(executor, execPrompt, { branchSuffix: "exec" }, context);

  void vscode.window.showInformationMessage(
    "Orchestrated: " +
      pm.label +
      " + " +
      executor.label +
      ". Watch the two terminals for live output."
  );
}

interface SpawnOptions {
  branchSuffix?: string;
}

async function spawnSession(
  def: AgentDefinition,
  prompt: string,
  opts: SpawnOptions,
  context: vscode.ExtensionContext
): Promise<void> {
  const health = agentHealth[def.id];
  if (health && !health.healthy) {
    const pick = await vscode.window.showWarningMessage(
      "Founder Cowork: " + (health.hint ?? def.detectCmd + " not found") + ". Spawn anyway?",
      "Spawn anyway",
      "Cancel"
    );
    if (pick !== "Spawn anyway") return;
  }

  if (def.promptInjection === "http") {
    void vscode.window.showInformationMessage(
      "Founder Cowork: " +
        def.label +
        " uses HTTP (no PTY session). " +
        "Use the Mission Control Ollama tab instead."
    );
    return;
  }

  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    void vscode.window.showErrorMessage("Founder Cowork: open a folder in VS Code first.");
    return;
  }
  const repoRoot = ws.uri.fsPath;

  const branchParts = ["fc", def.id];
  if (opts.branchSuffix) branchParts.push(opts.branchSuffix);
  branchParts.push(Date.now().toString(36).slice(-6));
  const branch = branchParts.join("-");

  const wtm = new WorktreeManager({ repoRoot });
  const worktree = await wtm.create({ branch });

  if (worktree.isFallback) {
    void vscode.window.showWarningMessage(
      "Founder Cowork: worktree creation failed — running in repo root instead."
    );
  }

  // Phase 3.2: thread account + accountManager into the runner. For
  // managed-account agents we read the active account from globalState; if
  // nothing's chosen we still spawn (with the system-default snapshot
  // implicitly preserved via the "no materialise" branch in AgentRunner).
  const account =
    def.authStyle === "managed-account" ? getActiveAccountId(context, def.id) : undefined;

  let session;
  try {
    session = await getRunner().spawn({
      agent: def,
      prompt,
      cwd: worktree.path,
      account,
      accountManager: account ? getAccountManager(context) : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("AgentRunner.spawn failed: " + msg);
    void vscode.window.showErrorMessage(
      "Founder Cowork: failed to spawn " + def.label + " — " + msg
    );
    return;
  }

  const accountSuffix = account ? " · @" + account : "";
  const terminalName = def.icon + " " + def.label + " · " + branch.slice(-8) + accountSuffix;
  const { terminal, dispose: disposeTerminal } = createSessionTerminal(session, terminalName);
  terminal.show(false);

  const entry: SessionEntry = {
    id: session.id,
    agent: def.label,
    agentId: def.id,
    branch: worktree.branch,
    status: "running",
    worktreePath: worktree.path,
    terminal,
    session,
    disposeTerminal,
    startedAt: session.startedAt,
  };
  sessionProvider?.add(entry);
  postSessionStarted(toSummary(entry));

  session.onExit(({ exitCode }) => {
    log.info("Session " + session.id + " (" + def.id + ") exited code=" + exitCode);
    sessionProvider?.update(session.id, { status: "exited" });
    postSessionExited(session.id, exitCode);
  });
}

function toSummary(e: SessionEntry): SessionSummary {
  return {
    id: e.id,
    agentId: e.agentId as AgentId,
    agentLabel: e.agent,
    branch: e.branch,
    worktreePath: e.worktreePath,
    status: e.status,
    pid: e.session.pid,
    startedAt: e.startedAt,
  };
}

function pushSessionsUpdate(): void {
  postSessionsUpdate((sessionProvider?.all() ?? []).map(toSummary));
}

async function cmdShowSession(sessionId?: string): Promise<void> {
  const entry = await resolveSession(sessionId);
  if (!entry) return;
  entry.terminal.show(false);
}

async function cmdKillSession(sessionId?: string): Promise<void> {
  const entry = await resolveSession(sessionId);
  if (!entry) return;
  try {
    entry.session.kill();
  } catch {
    /* no-op */
  }
  try {
    entry.disposeTerminal();
  } catch {
    /* no-op */
  }
  try {
    entry.terminal.dispose();
  } catch {
    /* no-op */
  }
  try {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (ws && entry.worktreePath !== ws.uri.fsPath) {
      const wtm = new WorktreeManager({ repoRoot: ws.uri.fsPath });
      void wtm.remove(entry.worktreePath);
    }
  } catch {
    /* no-op */
  }
  sessionProvider?.update(entry.id, { status: "killed" });
  postSessionExited(entry.id, 130);
  setTimeout(() => {
    sessionProvider?.remove(entry.id);
    pushSessionsUpdate();
  }, 2000);
}

async function resolveSession(sessionId?: string): Promise<SessionEntry | undefined> {
  if (sessionId && typeof sessionId === "string") {
    const direct = sessionProvider?.get(sessionId);
    if (direct) return direct;
  }
  const all = sessionProvider?.all() ?? [];
  if (all.length === 0) {
    void vscode.window.showInformationMessage(
      "Founder Cowork: no sessions. Spawn one with Ctrl+Shift+A."
    );
    return undefined;
  }
  if (all.length === 1) return all[0];
  const pick = await vscode.window.showQuickPick(
    all.map((s) => ({
      label: s.agent + " · " + s.branch,
      description: s.status,
      id: s.id,
    })),
    { placeHolder: "Select a session" }
  );
  return pick ? sessionProvider?.get(pick.id) : undefined;
}

async function pickAgent(placeHolder: string): Promise<AgentDefinition | undefined> {
  const agents = listAgents();
  const picked = await vscode.window.showQuickPick(
    agents.map((a) => {
      const h = agentHealth[a.id];
      const healthMark = h === undefined ? "" : h.healthy ? " ✓" : " ⚠";
      return {
        label: a.icon + "  " + a.label + healthMark,
        description: a.id,
        detail:
          (h && !h.healthy ? (h.hint ?? "not found") + " · " : "") +
          a.authStyle +
          " · prompt via " +
          a.promptInjection,
        id: a.id,
      };
    }),
    { placeHolder, matchOnDescription: true }
  );
  if (!picked) return undefined;
  return getAgent(picked.id as AgentId);
}

async function cmdPickVentureRoot(): Promise<void> {
  const result = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectMany: false,
    title: "Select Founder OS Venture Root Folder",
  });
  if (!result?.[0]) return;
  const path = result[0].fsPath;
  await vscode.workspace
    .getConfiguration("founderCowork")
    .update("ventureRoot", path, vscode.ConfigurationTarget.Global);
  postVentureRoot(path);
  void vscode.window.showInformationMessage("Venture root set: " + path);
}

// ──────────────────────────────────────────────
// Handoff inbox watcher
// ──────────────────────────────────────────────

function startWatching(ventureRoot: string, context: vscode.ExtensionContext): void {
  log.info("Starting handoff inbox watch on " + ventureRoot);
  unsubscribeInbox = watchInbox(ventureRoot, (bundle) =>
    handleBundle(bundle, ventureRoot, context)
  );
}

function restartWatch(context: vscode.ExtensionContext): void {
  unsubscribeInbox?.();
  unsubscribeInbox = null;
  const config = vscode.workspace.getConfiguration("founderCowork");
  const ventureRoot = config.get<string>("ventureRoot");
  const autoWatch = config.get<boolean>("autoWatch", true);
  if (ventureRoot && autoWatch) startWatching(ventureRoot, context);
}

async function handleBundle(
  bundle: HandoffBundle,
  ventureRoot: string,
  _context: vscode.ExtensionContext
): Promise<void> {
  log.info("Received bundle " + bundle.runId + " (" + bundle.type + ")");

  const claudeBinary =
    vscode.workspace.getConfiguration("founderCowork").get<string>("providers.claude.binaryName") ??
    "claude";

  const { bundle: accepted } = acceptBundle(bundle);
  consumeInboxFile(bundle.runId, ventureRoot);
  statusProvider?.addRun(bundle.runId, bundle.type);

  try {
    const result = await dispatchBundle(
      accepted,
      {
        ventureRoot,
        claudeBinary,
        onProgress: (evt) => {
          writeProgress(evt, ventureRoot);
          statusProvider?.updateRun(bundle.runId, evt.status, evt.percentComplete ?? 0);
        },
      },
      RUNNERS
    );
    writeResult(result, ventureRoot);
    statusProvider?.updateRun(bundle.runId, result.status, 100);
  } catch (err) {
    log.error("handleBundle error: " + String(err));
    const failure = makeFailureResult(bundle, "Runner error: " + String(err));
    writeResult(failure, ventureRoot);
    statusProvider?.updateRun(bundle.runId, "failed", 100);
  }
}
