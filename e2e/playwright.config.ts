import { defineConfig, devices } from '@playwright/test';

// Each isolated Make-driven run gets its own ignored artifact directory. This
// keeps passing screenshots/traces available while focused runs are iterated.
const artifactRun = process.env.PLAYWRIGHT_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
// Playwright clears outputDir at startup. Never allow a supplied run ID to
// escape test-results and delete reviewed visual references.
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(artifactRun)) {
  throw new Error('PLAYWRIGHT_RUN_ID must be a single safe directory name');
}

export default defineConfig({
  testDir: './tests',
  outputDir: `./test-results/${artifactRun}`,
  // testDir is /e2e/tests; both normal and update runs mount /e2e/visual-baselines.
  snapshotPathTemplate: '{testDir}/../visual-baselines/{testFilePath}/{testName}/{arg}-{projectName}{ext}',
  // All browser scenarios share one isolated Compose database and SMTP sink.
  // Keep scenarios serial so one flow cannot race another flow's admin/session setup.
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'https://chat.localhost',
    trace: 'retain-on-failure',
    screenshot: 'on',
    ignoreHTTPSErrors: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--ignore-certificate-errors', '--host-resolver-rules=MAP *.localhost host.docker.internal', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } } }],
});
