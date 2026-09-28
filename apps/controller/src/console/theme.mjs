import { button, element } from "./dom.mjs";

export const THEME_STORAGE_KEY = "openclaw.console.theme";

const explicitPreferences = new Set(["light", "dark"]);
const darkQuery = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;

function validPreference(value) {
  return explicitPreferences.has(value) ? value : null;
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
  if (persist && next !== "system") {
    writeStoredPreference(next);
  }
  const theme = effectiveTheme(next);
  document.documentElement.dataset.themePreference = next;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
  for (const item of document.querySelectorAll(".theme-control button[data-theme-choice]")) {
    item.setAttribute("aria-pressed", item.dataset.themeChoice === theme ? "true" : "false");
  }
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

const icons = {
  dark: [["path", { d: "M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z" }]],
  light: [
    ["circle", { cx: "12", cy: "12", r: "4" }],
    [
      "path",
      {
        d: "M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42",
      },
    ],
  ],
};

function themeIcon(preference) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  for (const [name, value] of Object.entries({
    viewBox: "0 0 24 24",
    width: "18",
    height: "18",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.8",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) {
    svg.setAttribute(name, value);
  }
  for (const [tag, attributes] of icons[preference]) {
    const shape = document.createElementNS(namespace, tag);
    for (const [name, value] of Object.entries(attributes)) {
      shape.setAttribute(name, value);
    }
    svg.append(shape);
  }
  return svg;
}

export function createThemeControl() {
  const control = element("div", {
    className: "theme-control",
    role: "group",
    "aria-label": "Appearance",
  });
  for (const [preference, label] of [
    ["dark", "Dark"],
    ["light", "Light"],
  ]) {
    const item = button("", () => applyThemePreference(preference, { persist: true }), {
      "aria-label": label,
      "aria-pressed": effectiveTheme() === preference ? "true" : "false",
      "data-theme-choice": preference,
      title: label,
    });
    item.append(themeIcon(preference));
    control.append(item);
  }
  return control;
}
