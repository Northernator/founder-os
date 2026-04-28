import type { AgentSession } from "@founder-os/agent-runner";
import * as vscode from "vscode";

export interface SessionEntry {
  id: string;
  agent: string;
  agentId: string;
  branch: string;
  status: "running" | "exited" | "killed";
  worktreePath: string;
  /** VS Code terminal pane that displays the PTY output. */
  terminal: vscode.Terminal;
  /** The underlying node-pty session (write/resize/kill). */
  session: AgentSession;
  /** Disposes the Pseudoterminal subscriptions (does NOT kill the session). */
  disposeTerminal: () => void;
  startedAt: number;
}

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionEntry> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionEntry | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly sessions = new Map<string, SessionEntry>();

  getTreeItem(entry: SessionEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(entry.agent, vscode.TreeItemCollapsibleState.None);
    item.description = entry.branch + " · " + entry.status;
    item.contextValue = "agentSession";
    item.iconPath = new vscode.ThemeIcon(
      entry.status === "running"
        ? "debug-start"
        : entry.status === "exited"
          ? "check"
          : "stop-circle"
    );
    item.tooltip =
      entry.agent +
      " session " +
      entry.id +
      "\nBranch: " +
      entry.branch +
      "\nWorktree: " +
      entry.worktreePath +
      "\nPID: " +
      entry.session.pid +
      "\nStarted: " +
      new Date(entry.startedAt).toLocaleTimeString();
    item.command = {
      command: "founderCowork.showSession",
      title: "Show",
      arguments: [entry.id],
    };
    return item;
  }

  getChildren(): SessionEntry[] {
    return [...this.sessions.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  add(entry: SessionEntry): void {
    this.sessions.set(entry.id, entry);
    this._onDidChangeTreeData.fire();
  }

  get(id: string): SessionEntry | undefined {
    return this.sessions.get(id);
  }

  update(id: string, patch: Partial<SessionEntry>): void {
    const e = this.sessions.get(id);
    if (!e) return;
    this.sessions.set(id, { ...e, ...patch });
    this._onDidChangeTreeData.fire();
  }

  remove(id: string): void {
    if (this.sessions.delete(id)) this._onDidChangeTreeData.fire();
  }

  all(): SessionEntry[] {
    return [...this.sessions.values()];
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}
