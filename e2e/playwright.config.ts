import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
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
