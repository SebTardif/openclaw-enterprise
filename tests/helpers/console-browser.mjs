import { after } from "node:test";

import { chromium } from "playwright";

// Instantiate once per test file. Only the browser process is shared: each call
// creates a nonpersistent context, with independent cookies, storage and pages.
export function createConsoleBrowserFixture() {
  let browser;
  let launching;
  let launches = 0;
  let contexts = 0;
  let launchMilliseconds = 0;
  let contextMilliseconds = 0;

  function currentBrowser() {
    if (browser?.isConnected()) return Promise.resolve(browser);
    if (launching === undefined) {
      const executablePath = process.env.OCC_TEST_BROWSER_EXECUTABLE || undefined;
      const started = performance.now();
      // Coalesce concurrent callers. A disconnected process is replaced for the
      // next case; the interrupted case still fails without replaying its work.
      launching = chromium
        .launch({ ...(executablePath === undefined ? {} : { executablePath }), headless: true })
        .then((launched) => {
          browser = launched;
          launches += 1;
          launchMilliseconds += performance.now() - started;
          return launched;
        })
        .finally(() => {
          launching = undefined;
        });
    }
    return launching;
  }

  after(async (t) => {
    try {
      await launching;
      await browser?.close();
    } finally {
      t.diagnostic(
        `console browser setup: launches=${launches} contexts=${contexts} launch_ms=${launchMilliseconds.toFixed(1)} context_ms=${contextMilliseconds.toFixed(1)}`,
      );
    }
  });

  return {
    async newContext(t, options = {}) {
      const current = await currentBrowser();
      const started = performance.now();
      const context = await current.newContext(options);
      contexts += 1;
      contextMilliseconds += performance.now() - started;
      // Register immediately so a failed page setup or assertion cannot leave
      // an authenticated context alive for the remainder of the file.
      t.after(() => context.close());
      return context;
    },
  };
}
