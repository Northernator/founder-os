import type React from "react";

export type CardProps = {
  title?: string;
  description?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  style?: React.CSSProperties;
  onClick?: () => void;
};

export function Card({ title, description, children, footer, style, onClick }: CardProps) {
  return (
    <div
      data-fos-panel
      className="fos-panel"
      onClick={onClick}
      style={{
        background: "var(--bg-panel)",
        color: "var(--text-primary)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-xl)",
        boxShadow: "var(--shadow-md)",
        overflow: "hidden",
        cursor: onClick ? "pointer" : undefined,
        transition: onClick ? "box-shadow 0.15s" : undefined,
        ...style,
      }}
    >
      {(title || description) && (
        <div
          style={{
            padding: "16px 20px",
            borderBottom: children || footer ? "1px solid var(--border-subtle)" : undefined,
          }}
        >
          {title && (
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>
              {title}
            </h3>
          )}
          {description && (
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-tertiary)" }}>
              {description}
            </p>
          )}
        </div>
      )}
      {children && <div style={{ padding: "16px 20px" }}>{children}</div>}
      {footer && (
        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid var(--border-subtle)",
            background: "var(--bg-elevated)",
          }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}
