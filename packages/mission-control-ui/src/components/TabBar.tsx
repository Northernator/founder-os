export type TabId =
  | "task"
  | "agents"
  | "skills"
  | "github"
  | "memory"
  | "vault"
  | "truth"
  | "ollama"
  | "explain";

export interface TabDef {
  id: TabId;
  label: string;
  hint: string;
}

export const TAB_DEFS: TabDef[] = [
  { id: "task", label: "Task", hint: "Spawn agents, orchestrate PM+Executor" },
  { id: "agents", label: "Agents", hint: "Health, accounts, switching" },
  { id: "skills", label: "Skills", hint: "Reusable agent skills (Phase 1b.X)" },
  { id: "github", label: "GitHub", hint: "Branch, commit, PR" },
  { id: "memory", label: "Memory", hint: "Project memory (InsForge in Phase 4)" },
  { id: "vault", label: "Vault", hint: "Wiki + knowledge base" },
  { id: "truth", label: "Truth", hint: "Generate Truth Layer for a target" },
  { id: "ollama", label: "Ollama", hint: "Local model chat via HTTP" },
  { id: "explain", label: "Explain", hint: "Explain code or selection" },
];

export function TabBar(props: {
  active: TabId;
  onChange: (id: TabId) => void;
}) {
  return (
    <div className="mc-tabs" role="tablist">
      {TAB_DEFS.map((t) => (
        <button
          type="button"
          key={t.id}
          role="tab"
          aria-selected={props.active === t.id}
          className="mc-tab"
          title={t.hint}
          onClick={() => props.onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
