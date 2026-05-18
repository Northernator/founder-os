import type React from "react";
import { useState } from "react";

export type AppShellProps = {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  /**
   * Optional pixel override. When omitted, the shell uses
   * `var(--sidebar-width)` so the Open CoDesign `sidebar-width` tweak
   * (default 240) controls the width live.
   */
  sidebarWidth?: number;
};

/** localStorage key the AppShell uses to remember the collapsed state
 *  across reloads. Mirrors the AI Chat sidebar's pattern in
 *  VentureDashboard so users only have to set their preference once. */
const SIDEBAR_COLLAPSED_KEY = "founder-os-sidebar-collapsed";

function readCollapsedPersisted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsedPersisted(v: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, v ? "1" : "0");
  } catch {
    // localStorage can throw in private-mode Safari etc -- collapse
    // toggling still works in-session, just won't persist. Don't crash.
  }
}

export function AppShell({ sidebar, children, sidebarWidth }: AppShellProps) {
  const width: string = sidebarWidth ? `${sidebarWidth}px` : "var(--sidebar-width)";
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsedPersisted);
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapsedPersisted(next);
      return next;
    });
  };

  return (
    <div
      className="app-shell"
      style={{
        display: "flex",
        height: "100vh",
        overflow: "hidden",
        fontFamily: "var(--font-family)",
        background: "var(--bg-app)",
        position: "relative",
      }}
    >
      {/* Sky glow + three floating clouds (Dreamlauncher visual layer).
          aria-hidden — purely decorative; z-index 0 keeps them behind the
          sidebar (z 2) and main content (z 1). All styles live in
          apps/founder-desktop/src/styles/dreamlauncher.css. */}
      <div className="sky-glow" aria-hidden="true" />
      <div className="cloud one" aria-hidden="true">
        <span />
      </div>
      <div className="cloud two" aria-hidden="true">
        <span />
      </div>
      <div className="cloud three" aria-hidden="true">
        <span />
      </div>

      {collapsed ? (
        /* Collapsed sidebar rail — 44px wide. Shows the cloud+rocket
           mark only (no wordmark / no tagline / no ventures list), an
           expand chevron, and a vertical "Founder OS" label. Mirrors
           the AI Chat sidebar's collapsed state on the right edge. */
        <aside
          data-fos-panel
          className="fos-panel sidebar sidebar-rail"
          style={{
            width: 44,
            minWidth: 44,
            borderRight: "1px solid var(--border-subtle)",
            background: "var(--bg-sidebar)",
            color: "var(--text-primary)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
            padding: "12px 0",
            zIndex: 2,
            position: "relative",
          }}
        >
          <div className="mark" aria-hidden="true">
            <span className="cloud-mark" />
            <span className="rocket-mark" />
          </div>
          <button
            type="button"
            onClick={toggleCollapsed}
            title="Expand sidebar"
            aria-label="Expand sidebar"
            style={{
              width: 24,
              height: 24,
              background: "transparent",
              border: "1px solid var(--border-subtle)",
              borderRadius: 4,
              cursor: "pointer",
              color: "var(--text-secondary)",
              fontSize: 13,
              lineHeight: 1,
              padding: 0,
              flex: "0 0 auto",
            }}
          >
            ›
          </button>
          <div
            style={{
              writingMode: "vertical-rl",
              transform: "rotate(180deg)",
              marginTop: 4,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: 0.5,
              color: "var(--text-tertiary)",
              textTransform: "uppercase",
              userSelect: "none",
            }}
          >
            Founder OS
          </div>
        </aside>
      ) : (
        /* Expanded sidebar — original full layout, plus an absolutely
           positioned collapse chevron in the top-right corner so the
           user can fold it down to the rail. */
        <aside
          data-fos-panel
          className="fos-panel sidebar"
          style={{
            width,
            minWidth: width,
            borderRight: "1px solid var(--border-subtle)",
            overflowY: "auto",
            background: "var(--bg-sidebar)",
            color: "var(--text-primary)",
            display: "flex",
            flexDirection: "column",
            zIndex: 2,
            position: "relative",
          }}
        >
          {sidebar}
          <button
            type="button"
            onClick={toggleCollapsed}
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
            style={{
              position: "absolute",
              top: 12,
              right: 8,
              width: 24,
              height: 24,
              background: "var(--bg-sidebar, #FFFFFF)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 4,
              cursor: "pointer",
              color: "var(--text-secondary)",
              fontSize: 13,
              lineHeight: 1,
              padding: 0,
              zIndex: 3,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            ‹
          </button>
        </aside>
      )}
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          background: "var(--bg-app)",
          color: "var(--text-primary)",
          position: "relative",
          zIndex: 1,
        }}
      >
        {children}
      </main>
    </div>
  );
}
