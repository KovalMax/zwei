import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
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
