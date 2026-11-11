import { create } from "zustand";
export type ThemePreference = "light" | "dark" | "system";
const STORAGE_KEY = "photofactory.theme";

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

export const useTheme = create<{ preference: ThemePreference; setPreference: (theme: ThemePreference) => void }>((set) => ({
  preference: savedTheme(),
  setPreference: (preference) => {
    try { localStorage.setItem(STORAGE_KEY, preference); } catch { /* keep the current session preference */ }
    applyTheme(preference);
    set({ preference });
  },
}));

export function initializeTheme() {
  applyTheme(useTheme.getState().preference);
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  media?.addEventListener("change", () => applyTheme(useTheme.getState().preference));
}
