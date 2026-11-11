import { afterEach, expect, it, vi } from "vitest";
import { applyTheme, initializeTheme, useTheme } from "./useTheme";

afterEach(() => { vi.unstubAllGlobals(); localStorage.removeItem("photofactory.theme"); useTheme.getState().setPreference("system"); });

it("persists an explicit theme and follows OS changes only in system mode", () => {
  let dark = true;
  let onChange = () => {};
  vi.stubGlobal("matchMedia", () => ({ get matches() { return dark; }, addEventListener: (_: string, fn: () => void) => { onChange = fn; } }));
  initializeTheme();
  useTheme.getState().setPreference("dark");
  expect(localStorage.getItem("photofactory.theme")).toBe("dark");
  dark = false;
  onChange();
  expect(document.documentElement.dataset.theme).toBe("dark");
  useTheme.getState().setPreference("system");
  expect(document.documentElement.dataset.theme).toBe("light");
  dark = true;
  onChange();
  expect(document.documentElement.dataset.theme).toBe("dark");
  applyTheme("light");
  expect(document.documentElement.style.colorScheme).toBe("light");
});
