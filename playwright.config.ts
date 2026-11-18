import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  outputDir: 'artifacts/browser/results',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'artifacts/browser/report', open: 'never' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:3000',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [{
    name: 'chromium',
    use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
  }],
  webServer: {
    // Both application children are started by one parent process. Do not start them
    // with separate sandbox exec calls: some executors isolate each network namespace.
    command: 'npm run dev',
    cwd: repositoryRoot,
    url: 'http://127.0.0.1:3000/api/v1/health',
    timeout: 120_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    env: {
      APP_MODE: 'demo',
      DATA_DIR: 'memory://',
      DATABASE_URL: '',
      API_HOST: '127.0.0.1',
      API_PORT: '4000',
      WEB_ORIGIN: 'http://127.0.0.1:3000',
      API_PROXY_ORIGIN: 'http://127.0.0.1:4000',
      AI_API_KEY: '',
      AI_API_URL: '',
      AI_MODEL: '',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
