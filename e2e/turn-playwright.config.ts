import {defineConfig, devices} from '@playwright/test';

const run = process.env.PLAYWRIGHT_RUN_ID ?? '';
if (!/^turn-[A-Za-z0-9_-]+$/.test(run)) throw new Error('TURN acceptance requires a harness-generated run ID');
const resolver = process.env.PLAYWRIGHT_HOST_RESOLVER_RULES ?? '';
if (resolver !== 'MAP turn.chat.localhost 172.30.10.251,MAP *.localhost host.docker.internal') throw new Error('TURN acceptance requires the isolated resolver');

export default defineConfig({
  testDir: './turn-tests',
  // The runner container is disposable; do not retain diagnostic artifacts on the host.
  outputDir: '/tmp/zwei-turn-test-results',
  timeout: 150_000,
  globalTimeout: 270_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'https://chat.localhost',
    ignoreHTTPSErrors: true,
    trace: 'off', screenshot: 'off', video: 'off',
  },
  projects: [{name: 'chromium', use: {...devices['Desktop Chrome'], launchOptions: {args: [
    '--ignore-certificate-errors', `--host-resolver-rules=${resolver}`,
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  ]}}}],
});
