import type React from "react";
import { useEffect, useState } from "react";
import { THEME_ORDER, type Theme, useTheme } from "../../lib/theme.js";

const NEXT_LABEL: Record<Theme, string> = {
  light: "Switch to dark",
  dark: "Switch to grey",
  grey: "Switch to rainbow",
  rainbow: "Switch to light",
};

const THEME_LABEL: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
  grey: "Grey",
  rainbow: "Rainbow",
};

// biome-ignore lint/correctness/noUnusedVariables: kept for future use / interface compatibility
function nextTheme(current: Theme): Theme {
  const idx = THEME_ORDER.indexOf(current);
  return THEME_ORDER[(idx + 1) % THEME_ORDER.length] ?? "light";
}

type Size = "sm" | "md";

export function ThemeToggle({ size = "md" }: { size?: Size } = {}) {
  const { theme, cycleTheme, toggleRainbowWarp } = useTheme();
  const [animKey, setAnimKey] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally omitted
  useEffect(() => {
    setAnimKey((k) => k + 1);
  }, [theme]);

  const px = size === "sm" ? 28 : 32;
  const iconPx = size === "sm" ? 16 : 18;

  const handleClick = (e: React.MouseEvent) => {
    if (e.shiftKey && theme === "rainbow") {
      toggleRainbowWarp();
      return;
    }
    cycleTheme();
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title={`${THEME_LABEL[theme]} theme — ${NEXT_LABEL[theme]} (shift+click in rainbow for warp)`}
      aria-label={NEXT_LABEL[theme]}
      style={{
        width: px,
        height: px,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-elevated)",
        color: "var(--text-secondary)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 8,
        cursor: "pointer",
        padding: 0,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <span
        key={animKey}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: iconPx,
          height: iconPx,
          animation: "fos-theme-icon-in 200ms ease-out",
        }}
      >
        <ThemeIcon theme={theme} size={iconPx} />
      </span>
      {/* Inline keyframes — kept local so the toggle is self-contained.
          Pointer-events stay active during the swap. */}
      <style>{`
        @keyframes fos-theme-icon-in {
          0%   { opacity: 0; transform: rotate(-25deg) scale(0.85); }
          100% { opacity: 1; transform: rotate(0deg) scale(1); }
        }
      `}</style>
    </button>
  );
}

function ThemeIcon({ theme, size }: { theme: Theme; size: number }) {
  if (theme === "light") return <SunIcon size={size} />;
  if (theme === "dark") return <MoonIcon size={size} />;
  if (theme === "grey") return <CloudHalfIcon size={size} />;
  return <RainbowDotIcon size={size} />;
}

function SunIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="M4.93 4.93l1.41 1.41" />
      <path d="M17.66 17.66l1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="M4.93 19.07l1.41-1.41" />
      <path d="M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function CloudHalfIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" fill="currentColor" fillOpacity="0.15" />
      <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

function RainbowDotIcon({ size }: { size: number }) {
  const id = "fos-rainbow-grad";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ff6b6b" />
          <stop offset="20%" stopColor="#ffd93d" />
          <stop offset="40%" stopColor="#6bcb77" />
          <stop offset="60%" stopColor="#4d96ff" />
          <stop offset="80%" stopColor="#b06bff" />
          <stop offset="100%" stopColor="#ff6bd6" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="9" fill={`url(#${id})`} />
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth={1.5}
      />
    </svg>
  );
}
