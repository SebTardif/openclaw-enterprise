// Run before stylesheets so the saved appearance applies to the first paint.
(() => {
  const storageKey = "occ.console.appearance";
  const root = document.documentElement;
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const normalize = (value) => (["light", "dark"].includes(value) ? value : "system");
  let preference = "system";
  let storage = null;
  try {
    storage = window.localStorage;
    preference = normalize(storage.getItem(storageKey));
  } catch {
    // Appearance remains usable when browser storage is unavailable.
  }

  function apply() {
    root.dataset.appearance = preference;
    let theme = preference;
    if (preference === "system") {
      theme = system.matches ? "dark" : "light";
    }
    root.dataset.theme = theme;
    const select = document.getElementById("console-appearance");
    if (select) {
      select.value = preference;
    }
  }

  apply();
  system.addEventListener("change", apply);
  window.addEventListener("storage", (event) => {
    if (event.storageArea !== storage || (event.key !== storageKey && event.key !== null)) {
      return;
    }
    preference = normalize(event.newValue);
    apply();
  });
  document.addEventListener("change", (event) => {
    if (event.target.id !== "console-appearance") {
      return;
    }
    preference = normalize(event.target.value);
    apply();
    const status = document.getElementById("appearance-status");
    try {
      if (!storage) {
        throw new Error("Browser storage is unavailable");
      }
      storage.setItem(storageKey, preference);
      if (status) {
        status.textContent = "Appearance saved for this browser.";
      }
    } catch {
      if (status) {
        status.textContent = "Appearance changed for this tab. Browser storage is unavailable.";
      }
    }
  });
})();
