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
        style={{
          width: sidebarWidth,
          minWidth: sidebarWidth,
          borderRight: "1px solid #E5E7EB",
          overflowY: "auto",
          background: "#FAFAFA",
        }}
      >
        {sidebar}
      </aside>
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          background: "#FFFFFF",
        }}
      >
        {children}
      </main>
    </div>
  );
}
