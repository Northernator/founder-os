import * as vscode from "vscode";

type RunEntry = {
  runId: string;
  type: string;
  status: string;
  percent: number;
};

export class StatusTreeProvider implements vscode.TreeDataProvider<RunEntry> {
  private _onDidChangeTreeData = new vscode.EventEmitter<RunEntry | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private runs: Map<string, RunEntry> = new Map();

  getTreeItem(entry: RunEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(
      `${entry.type} — ${entry.runId.slice(0, 8)}`,
      vscode.TreeItemCollapsibleState.None
    );
    const icon =
      entry.status === "success" ? "check"
      : entry.status === "failed" ? "error"
      : entry.status === "running" ? "loading~spin"
      : "circle-outline";
    item.iconPath = new vscode.ThemeIcon(icon);
    item.description = `${entry.status} ${entry.percent > 0 ? `(${entry.percent}%)` : ""}`;
    return item;
  }

  getChildren(): RunEntry[] {
    return Array.from(this.runs.values()).reverse();
  }

  addRun(runId: string, type: string): void {
    this.runs.set(runId, { runId, type, status: "accepted", percent: 0 });
    this._onDidChangeTreeData.fire();
  }

  updateRun(runId: string, status: string, percent: number): void {
    const entry = this.runs.get(runId);
    if (entry) {
      this.runs.set(runId, { ...entry, status, percent });
      this._onDidChangeTreeData.fire();
    }
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}
