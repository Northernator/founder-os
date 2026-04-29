import type React from "react";

export type AppShellProps = {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  sidebarWidth?: number;
};

export function AppShell({ sidebar, children, sidebarWidth = 240 }: AppShellProps) {
  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        overflow: "hidden",
        fontFamily: "Inter, sans-serif",
      }}
    >
      <aside
        data-fos-panel
        className="fos-panel"
        style={{
          width: sidebarWidth,
          minWidth: sidebarWidth,
          borderRight: "1px solid var(--border-subtle)",
          overflowY: "auto",
          background: "var(--bg-sidebar)",
          color: "var(--text-primary)",
        }}
      >
        {sidebar}
      </aside>
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          background: "var(--bg-app)",
          color: "var(--text-primary)",
        }}
      >
        {children}
      </main>
    </div>
  );
}
