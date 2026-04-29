import type React from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children: React.ReactNode;
};

const VARIANT_STYLES: Record<ButtonVariant, React.CSSProperties> = {
  primary: { background: "var(--accent)", color: "var(--accent-fg)", border: "none" },
  secondary: {
    background: "var(--bg-hover)",
    color: "var(--text-secondary)",
    border: "1px solid var(--border-input)",
  },
  ghost: {
    background: "transparent",
    color: "var(--text-secondary)",
    border: "1px solid transparent",
  },
  danger: { background: "var(--danger)", color: "var(--danger-fg)", border: "none" },
};

const SIZE_STYLES: Record<ButtonSize, React.CSSProperties> = {
  sm: { padding: "4px 10px", fontSize: 12, borderRadius: 5 },
  md: { padding: "8px 16px", fontSize: 14, borderRadius: 6 },
  lg: { padding: "12px 24px", fontSize: 15, borderRadius: 8 },
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  children,
  style,
  ...props
}: ButtonProps) {
  return (
    <button
      disabled={disabled ?? loading}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontWeight: 600,
        cursor: disabled || loading ? "not-allowed" : "pointer",
        opacity: disabled || loading ? 0.6 : 1,
        transition: "opacity 0.15s",
        ...VARIANT_STYLES[variant],
        ...SIZE_STYLES[size],
        ...style,
      }}
      {...props}
    >
      {loading && (
        <span
          style={{
            width: 14,
            height: 14,
            border: "2px solid currentColor",
            borderTopColor: "transparent",
            borderRadius: "50%",
            display: "inline-block",
            animation: "spin 0.7s linear infinite",
          }}
        />
      )}
      {children}
    </button>
  );
}
