import type {
  AgentHealthMap,
  AgentSummary,
  HostToWebviewMessage,
  InitState,
  SessionSummary,
} from "@founder-os/mission-control-protocol";
import { useEffect, useState } from "react";
import { TAB_DEFS, TabBar, type TabId } from "./components/TabBar.js";
import { onHostMessage, send } from "./lib/vscode.js";
import { AgentsTab } from "./tabs/AgentsTab.js";
import { ExplainTab } from "./tabs/ExplainTab.js";
import { GitHubTab } from "./tabs/GitHubTab.js";
import { MemoryTab } from "./tabs/MemoryTab.js";
import { OllamaTab } from "./tabs/OllamaTab.js";
import { SkillsTab } from "./tabs/SkillsTab.js";
import { TaskTab } from "./tabs/TaskTab.js";
import { TruthTab } from "./tabs/TruthTab.js";
import { VaultTab } from "./tabs/VaultTab.js";

const EMPTY_STATE: InitState = {
  protocolVersion: 1,
  extensionVersion: "?",
  agents: [],
  agentHealth: {},
  sessions: [],
  ventureRoot: null,
};

export function App() {
  const [state, setState] = useState<InitState>(EMPTY_STATE);
  const [activeTab, setActiveTab] = useState<TabId>("task");
  const [hydrated, setHydrated] = useState(false);

  // Subscribe to host messages once.
  useEffect(() => {
    const unsub = onHostMessage((m: HostToWebviewMessage) => {
      switch (m.type) {
        case "init":
          setState(m.state);
          setHydrated(true);
          break;
        case "agents:health":
          setState((s) => ({ ...s, agentHealth: m.health }));
          break;
        case "sessions:update":
          setState((s) => ({ ...s, sessions: m.sessions }));
          break;
        case "session:started":
          setState((s) => ({ ...s, sessions: [m.session, ...s.sessions] }));
          break;
        case "session:exited":
          setState((s) => ({
            ...s,
            sessions: s.sessions.map((sess) =>
              sess.id === m.sessionId ? { ...sess, status: "exited" } : sess
            ),
          }));
          break;
        case "ventureRoot:changed":
          setState((s) => ({ ...s, ventureRoot: m.ventureRoot }));
          break;
        case "toast":
          // Lightweight: just log; Phase 1b.X may add a real toast UI.
          console.log("[toast " + m.level + "]", m.message);
          break;
        case "response":
          // Handled by the request() promise wrappers.
          break;
      }
    });
    // Tell the host we're alive — host responds with `init`.
    send({ type: "ready" });
    return unsub;
  }, []);

  return (
    <div className="mc-shell">
      <header className="mc-header">
        <h1 className="mc-title">Founder Cowork — Mission Control</h1>
        <p className="mc-subtitle">
          v{state.extensionVersion}
          {state.ventureRoot ? " · venture: " + state.ventureRoot : " · no venture root selected"}
          {!hydrated && " · waiting for extension host…"}
        </p>
        <TabBar active={activeTab} onChange={setActiveTab} />
      </header>
      <main className="mc-body">{renderTab(activeTab, state)}</main>
    </div>
  );
}

function renderTab(id: TabId, state: InitState) {
  const props: TabProps = {
    agents: state.agents,
    agentHealth: state.agentHealth,
    sessions: state.sessions,
    ventureRoot: state.ventureRoot,
  };
  switch (id) {
    case "task":
      return <TaskTab {...props} />;
    case "agents":
      return <AgentsTab {...props} />;
    case "skills":
      return <SkillsTab {...props} />;
    case "github":
      return <GitHubTab {...props} />;
    case "memory":
      return <MemoryTab {...props} />;
    case "vault":
      return <VaultTab {...props} />;
    case "truth":
      return <TruthTab {...props} />;
    case "ollama":
      return <OllamaTab {...props} />;
    case "explain":
      return <ExplainTab {...props} />;
  }
  // Exhaustiveness check
  const _exhaustive: never = id;
  void _exhaustive;
  void TAB_DEFS;
  return <div>unknown tab</div>;
}

export interface TabProps {
  agents: AgentSummary[];
  agentHealth: AgentHealthMap;
  sessions: SessionSummary[];
  ventureRoot: string | null;
}
