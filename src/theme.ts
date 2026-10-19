export type Theme = "light" | "dark";
export type Mode = "simple" | "advanced";

const THEME_KEY = "diskviz.theme";
const MODE_KEY = "diskviz.mode";

export function loadStoredTheme(): Theme | null {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === "light" || stored === "dark" ? stored : null;
}

export function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function storeTheme(theme: Theme): void {
  localStorage.setItem(THEME_KEY, theme);
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
}

export function loadStoredMode(): Mode | null {
  const stored = localStorage.getItem(MODE_KEY);
  return stored === "simple" || stored === "advanced" ? stored : null;
}

export function storeMode(mode: Mode): void {
  localStorage.setItem(MODE_KEY, mode);
}
