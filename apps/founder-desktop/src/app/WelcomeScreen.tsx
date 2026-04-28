import React from "react";

export function WelcomeScreen() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        gap: 20,
        color: "#6B7280",
      }}
    >
      <div style={{ fontSize: 48 }}>🚀</div>
      <h1 style={{ fontSize: 28, fontWeight: 800, color: "#111827", margin: 0 }}>
        Founder OS
      </h1>
      <p style={{ fontSize: 16, maxWidth: 400, textAlign: "center", lineHeight: 1.6 }}>
        Select a venture from the sidebar, or create a new one to get started.
      </p>
    </div>
  );
}
