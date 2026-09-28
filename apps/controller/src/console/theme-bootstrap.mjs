(function () {
  const key = "openclaw.console.theme";
  const choices = new Set(["light", "dark"]);
  const root = document.documentElement;
  function storyTheme() {
    if (location.pathname !== "/storybook-fixtures/frame.html") {
      return null;
    }
    const value = new URL(location.href).searchParams.get("theme");
    return choices.has(value) ? value : null;
  }
  function storedTheme() {
    try {
      const value = localStorage.getItem(key);
      return choices.has(value) ? value : null;
    } catch {
      return null;
    }
  }
  const preference = storyTheme() ?? storedTheme() ?? "system";
  const dark =
    preference === "dark" ||
    (preference === "system" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches === true);
  root.dataset.themePreference = preference;
  root.dataset.theme = dark ? "dark" : "light";
})();
