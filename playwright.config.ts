import { defineConfig } from "@playwright/test";

/** The port the built site is served on for the browser tests. */
const PORT = 4173;

/**
 * Browser tests of the built site (`pnpm run test:e2e`): the preview, the listing and the lazy chunks run in a real Chromium against site-dist/, with every network request the site makes answered by the test, so nothing touches a real host. The files end in .browser.ts so vitest does not collect them.
 */
export default defineConfig({
  testDir: "./site/e2e",
  testMatch: "**/*.browser.ts",
  fullyParallel: true,
  use: { baseURL: `http://localhost:${String(PORT)}/` },
  webServer: { command: "tsx site/e2e/serve.ts", url: `http://localhost:${String(PORT)}/`, env: { PORT: String(PORT) }, reuseExistingServer: false },
});
