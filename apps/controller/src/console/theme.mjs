export const THEME_STORAGE_KEY = "openclaw.console.theme";

const preferences = new Set(["system", "light", "dark"]);
const darkQuery = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;

function validPreference(value) {
  return preferences.has(value) ? value : null;
}

function readStoredPreference() {
  try {
    return validPreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStoredPreference(preference) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* Browser storage can be disabled; the current document still updates. */
  }
}

export function getThemePreference() {
  return (
    readStoredPreference() ??
    validPreference(document.documentElement.dataset.themePreference) ??
    "system"
  );
}

export function effectiveTheme(preference = getThemePreference()) {
  if (preference === "dark" || (preference === "system" && darkQuery?.matches)) {
    return "dark";
  }
  return "light";
}

export function applyThemePreference(preference, { persist = false } = {}) {
  const next = validPreference(preference) ?? "system";
  if (persist) {
    writeStoredPreference(next);
  }
  const theme = effectiveTheme(next);
  document.documentElement.dataset.themePreference = next;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
  window.dispatchEvent(new CustomEvent("openclaw-theme-change", { detail: { preference: next } }));
  return next;
}

export function initializeConsoleTheme() {
  applyThemePreference(getThemePreference());
  darkQuery?.addEventListener("change", () => {
    if (getThemePreference() === "system") {
      applyThemePreference("system");
    }
  });
}
