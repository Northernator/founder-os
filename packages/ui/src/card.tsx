import React from "react";

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
      onClick={onClick}
      style={{
        background: "#FFFFFF",
        border: "1px solid #E5E7EB",
        borderRadius: 10,
        overflow: "hidden",
        cursor: onClick ? "pointer" : undefined,
        transition: onClick ? "box-shadow 0.15s" : undefined,
        ...style,
      }}
    >
      {(title || description) && (
        <div style={{ padding: "16px 20px", borderBottom: children || footer ? "1px solid #F3F4F6" : undefined }}>
          {title && (
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "#111827" }}>{title}</h3>
          )}
          {description && (
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6B7280" }}>{description}</p>
          )}
        </div>
      )}
      {children && (
        <div style={{ padding: "16px 20px" }}>{children}</div>
      )}
      {footer && (
        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid #F3F4F6",
            background: "#FAFAFA",
          }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}
