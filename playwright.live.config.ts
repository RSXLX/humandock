import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/live-workflow.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 1,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  outputDir: 'artifacts/browser-live/results',
  reporter: [['list'], ['html', { outputFolder: 'artifacts/browser-live/report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:3000',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium-local-chain', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } }],
  webServer: {
    // This parent starts a throwaway Ganache chain, API, and Next in one network namespace.
    // It never connects to a user's wallet or an external ME network.
    command: 'node --import tsx scripts/dev-me-local.ts',
    cwd: repositoryRoot,
    url: 'http://127.0.0.1:3000/api/v1/health',
    timeout: 180_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    env: {
      WEB_PORT: '3000', API_PORT: '4000', ME_LOCAL_PORT: '18545',
      API_HOST: '127.0.0.1', AI_API_KEY: '', AI_API_URL: '', AI_MODEL: '',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
