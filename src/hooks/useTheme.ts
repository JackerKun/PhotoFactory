import { create } from "zustand";
export type ThemePreference = "light" | "dark" | "system";
export const palettes = {
  graphite: "石墨",
  film: "胶片",
  pine: "松绿",
  navy: "海军蓝",
  blue: "经典蓝",
} as const;
export const uiStyles = { compact: "紧凑", standard: "标准", original: "原版" } as const;
export type ThemePalette = keyof typeof palettes;
export type UiStyle = keyof typeof uiStyles;
const STORAGE_KEY = "photofactory.theme";
const PALETTE_KEY = "photofactory.palette";
const STYLE_KEY = "photofactory.uiStyle";

function savedChoice<T extends string>(key: string, choices: Record<T, string>, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value && Object.prototype.hasOwnProperty.call(choices, value) ? value as T : fallback;
  } catch { return fallback; }
}

function saveChoice(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* keep the current session preference */ }
}

function savedTheme(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch { return "system"; }
}

export function applyTheme(preference: ThemePreference) {
  const dark = preference === "dark" || (preference === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

interface Appearance {
  preference: ThemePreference;
  palette: ThemePalette;
  uiStyle: UiStyle;
  setPreference: (theme: ThemePreference) => void;
  setPalette: (palette: ThemePalette) => void;
  setUiStyle: (style: UiStyle) => void;
}

export const useTheme = create<Appearance>((set) => ({
  preference: savedTheme(),
  palette: savedChoice(PALETTE_KEY, palettes, "graphite"),
  uiStyle: savedChoice(STYLE_KEY, uiStyles, "compact"),
  setPreference: (preference) => {
    saveChoice(STORAGE_KEY, preference);
    applyTheme(preference);
    set({ preference });
  },
  setPalette: (palette) => {
    saveChoice(PALETTE_KEY, palette);
    document.documentElement.dataset.palette = palette;
    set({ palette });
  },
  setUiStyle: (uiStyle) => {
    saveChoice(STYLE_KEY, uiStyle);
    document.documentElement.dataset.uiStyle = uiStyle;
    set({ uiStyle });
  },
}));

export function initializeTheme() {
  const { preference, palette, uiStyle } = useTheme.getState();
  applyTheme(preference);
  document.documentElement.dataset.palette = palette;
  document.documentElement.dataset.uiStyle = uiStyle;
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  media?.addEventListener("change", () => applyTheme(useTheme.getState().preference));
}
