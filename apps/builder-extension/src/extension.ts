import * as vscode from "vscode";
import { watchInbox } from "@founder-os/handoff-vscode";
import { acceptBundle, consumeInboxFile } from "@founder-os/handoff-vscode";
import { writeResult, writeProgress, makeSuccessResult, makeFailureResult } from "@founder-os/handoff-vscode";
import { createLogger } from "@founder-os/logger";
import { setTransport } from "@founder-os/prompt-master";
import { createClaudeCliTransport, installNodeBackends } from "@founder-os/prompt-master/node";

// Wire the Node-only cache + telemetry backends once at extension load. Idempotent.
installNodeBackends();
import type { HandoffBundle } from "@founder-os/handoff-contract";
import { BuildRunner } from "./runners/build-runner.js";
import { StatusTreeProvider } from "./views/status-tree.js";

const log = createLogger("builder-extension");

let unsubscribeInbox: (() => void) | null = null;
let statusProvider: StatusTreeProvider | null = null;

export function activate(context: vscode.ExtensionContext): void {
  log.info("Founder OS Builder activating…");

  // Wire up Prompt Master via the Claude CLI subprocess - no separate API
  // key needed. Uses whatever auth the CLI itself has (OAuth from
  // `claude login`). If the binary isn't on PATH, optimize() falls back
  // to identity.
  try {
    setTransport(
      createClaudeCliTransport({
        binary: "claude",
        extraArgs: ["--model", "claude-haiku-4-5-20251001"],
      }),
    );
    log.info("prompt-master: claude-cli transport registered (uses CLI auth)");
  } catch (err) {
    log.warn(`prompt-master: transport setup failed (${err}), falling back to no-op`);
  }

  // Status tree view
  statusProvider = new StatusTreeProvider();
  vscode.window.registerTreeDataProvider("founderOs.status", statusProvider);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("founderOs.pickVentureRoot", cmdPickVentureRoot),
    vscode.commands.registerCommand("founderOs.runPipeline", cmdRunPipeline),
    vscode.commands.registerCommand("founderOs.acceptHandoff", cmdAcceptHandoff),
    vscode.commands.registerCommand("founderOs.showStatus", cmdShowStatus),
  );

  // Auto-watch if configured
  const config = vscode.workspace.getConfiguration("founderOs");
  const ventureRoot = config.get<string>("ventureRoot");
  const autoWatch = config.get<boolean>("autoWatch", true);

  if (ventureRoot && autoWatch) {
    startWatching(ventureRoot, context);
  }

  // Watch for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("founderOs.ventureRoot") || e.affectsConfiguration("founderOs.autoWatch")) {
        restartWatch(context);
      }
    })
  );

  log.info("Founder OS Builder activated");
  vscode.window.showInformationMessage("Founder OS Builder is active 🚀");
}

export function deactivate(): void {
  unsubscribeInbox?.();
  log.info("Founder OS Builder deactivated");
}

// ──────────────────────────────────────────────
// Commands
// ──────────────────────────────────────────────

async function cmdPickVentureRoot(): Promise<void> {
  const result = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectMany: false,
    title: "Select Venture Root Folder",
  });
  if (!result?.[0]) return;
  const path = result[0].fsPath;
  await vscode.workspace.getConfiguration("founderOs").update(
    "ventureRoot",
    path,
    vscode.ConfigurationTarget.Global
  );
  vscode.window.showInformationMessage(`Venture root set to: ${path}`);
}

async function cmdRunPipeline(): Promise<void> {
  const ventureRoot = getVentureRoot();
  if (!ventureRoot) return;
  vscode.window.showInformationMessage("Pipeline run initiated (desktop app controls the pipeline)");
}

async function cmdAcceptHandoff(): Promise<void> {
  const ventureRoot = getVentureRoot();
  if (!ventureRoot) return;
  vscode.window.showInformationMessage("Watching inbox for bundles…");
}

function cmdShowStatus(): void {
  statusProvider?.refresh();
}

// ──────────────────────────────────────────────
// Inbox watcher
// ──────────────────────────────────────────────

function startWatching(ventureRoot: string, context: vscode.ExtensionContext): void {
  log.info(`Starting inbox watch for ${ventureRoot}`);
  unsubscribeInbox = watchInbox(ventureRoot, (bundle) =>
    handleBundle(bundle, ventureRoot, context)
  );
}

function restartWatch(context: vscode.ExtensionContext): void {
  unsubscribeInbox?.();
  unsubscribeInbox = null;
  const config = vscode.workspace.getConfiguration("founderOs");
  const ventureRoot = config.get<string>("ventureRoot");
  const autoWatch = config.get<boolean>("autoWatch", true);
  if (ventureRoot && autoWatch) {
    startWatching(ventureRoot, context);
  }
}

function getVentureRoot(): string | null {
  const root = vscode.workspace
    .getConfiguration("founderOs")
    .get<string>("ventureRoot");
  if (!root) {
    vscode.window.showWarningMessage(
      "Founder OS: venture root not set. Run 'Founder OS: Select Venture Folder' first.",
    );
    return null;
  }
  return root;
}

async function handleBundle(
  bundle: HandoffBundle,
  ventureRoot: string,
  context: vscode.ExtensionContext
): Promise<void> {
  log.info(`Received bundle ${bundle.runId} (${bundle.type})`);

  const claudeBinary = vscode.workspace
    .getConfiguration("founderOs")
    .get<string>("claudeBinaryName") ?? "claude";

  const { bundle: accepted } = acceptBundle(bundle);
  consumeInboxFile(bundle.runId, ventureRoot);

  statusProvider?.addRun(bundle.runId, bundle.type);

  try {
    const runner = new BuildRunner(accepted, ventureRoot, claudeBinary, (evt) => {
      writeProgress(evt, ventureRoot);
      statusProvider?.updateRun(bundle.runId, evt.status, evt.percentComplete ?? 0);
    });
    const result = await runner.run();
    writeResult(result, ventureRoot);
    statusProvider?.updateRun(
      bundle.runId,
      result.status,
      100,
    );
  } catch (err) {
    log.error(`handleBundle error: ${err}`);
    const failure = makeFailureResult(bundle, `Runner error: ${err}`);
    writeResult(failure, ventureRoot);
    statusProvider?.updateRun(bundle.runId, "failed", 100);
  }
}
