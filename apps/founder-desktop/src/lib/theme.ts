import { create } from "zustand";

export type Theme = "light" | "dark" | "grey" | "rainbow";

const THEMES: Theme[] = ["light", "dark", "grey", "rainbow"];
const STORAGE_KEY = "founder-os-theme";
const WARP_CLASS = "rainbow-warp";

function isTheme(v: unknown): v is Theme {
  return typeof v === "string" && (THEMES as string[]).includes(v);
}

function readInitial(): Theme {
  if (typeof window === "undefined") return "light";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(v) ? v : "light";
  } catch {
    return "light";
  }
}

function applyToDocument(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  if (theme !== "rainbow") {
    document.documentElement.classList.remove(WARP_CLASS);
  }
}

type ThemeStore = {
  theme: Theme;
  setTheme: (t: Theme) => void;
  cycleTheme: () => void;
  toggleRainbowWarp: () => void;
};

const initial = readInitial();
applyToDocument(initial);

export const useThemeStore = create<ThemeStore>((set, get) => ({
  theme: initial,
  setTheme: (t) => {
    applyToDocument(t);
    try {
      window.localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* private mode / disabled storage — silently ignore */
    }
    set({ theme: t });
  },
  cycleTheme: () => {
    const idx = THEMES.indexOf(get().theme);
    const next = THEMES[(idx + 1) % THEMES.length] ?? "light";
    get().setTheme(next);
  },
  toggleRainbowWarp: () => {
    if (typeof document === "undefined") return;
    if (get().theme !== "rainbow") return;
    document.documentElement.classList.toggle(WARP_CLASS);
  },
}));

export function useTheme() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const cycleTheme = useThemeStore((s) => s.cycleTheme);
  const toggleRainbowWarp = useThemeStore((s) => s.toggleRainbowWarp);
  return { theme, setTheme, cycleTheme, toggleRainbowWarp };
}

export const THEME_ORDER = THEMES;
