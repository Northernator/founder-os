/**
 * Wraps an AgentSession in a vscode.Pseudoterminal so the user sees PTY
 * output in a real VS Code terminal pane (with scrollback, copy/paste, ANSI
 * colors, font/zoom config — everything the integrated terminal already does).
 *
 * Why a Pseudoterminal instead of vscode.window.createTerminal({ cwd })?
 *   - createTerminal({ cwd }) spawns the user's shell; we'd then have to
 *     terminal.sendText("claude '...'") which depends on the shell to parse
 *     escapes correctly. That's exactly the .ps1 quoting hell from the
 *     screenshot we're moving away from.
 *   - With Pseudoterminal we OWN the input/output stream. node-pty hosts the
 *     real process; the VS Code terminal is just a viewport.
 */

import type { AgentSession } from "@founder-os/agent-runner";
import * as vscode from "vscode";

export interface SessionTerminalHandles {
  /** The terminal shown in the VS Code panel. */
  terminal: vscode.Terminal;
  /** Disposes the Pseudoterminal subscriptions (does NOT kill the session). */
  dispose(): void;
}

export function createSessionTerminal(session: AgentSession, name: string): SessionTerminalHandles {
  const writeEmitter = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<number>();

  const dataSub = session.onData((chunk) => writeEmitter.fire(chunk));
  const exitSub = session.onExit(({ exitCode }) => closeEmitter.fire(exitCode));

  const pty: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open: (initialDimensions) => {
      if (initialDimensions) {
        session.resize(initialDimensions.columns, initialDimensions.rows);
      }
    },
    close: () => {
      // User closed the terminal pane → kill the agent.
      session.kill();
    },
    handleInput: (data) => {
      // Forward keystrokes to the PTY (so the user can interact).
      session.write(data);
    },
    setDimensions: (dim) => {
      session.resize(dim.columns, dim.rows);
    },
  };

  const terminal = vscode.window.createTerminal({ name, pty });

  return {
    terminal,
    dispose: () => {
      dataSub.dispose();
      exitSub.dispose();
      writeEmitter.dispose();
      closeEmitter.dispose();
    },
  };
}
