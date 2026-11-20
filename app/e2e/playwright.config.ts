import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config · e-Service เทศบาลนครตัวอย่าง (TEST-PLAN 51 TC)
 * - BASE_URL จาก env (ค่าเริ่มต้น http://localhost:3000) · เว็บต้องรันด้วย TEST_MODE=1
 * - เว็บมีสถานะกลางชุดเดียว (reset/clock) → รันทีละ test เสมอ (workers = 1, ไม่ fullyParallel)
 * - ทุก TC เริ่มด้วย POST /api/test/reset แล้วล็อกอินใหม่ (ดู helpers.ts)
 */
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './tests',
  globalSetup: require.resolve('./global-setup'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 180_000,
  expect: { timeout: 7_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }], ['json', { outputFile: 'test-results/results.json' }]],
  outputDir: 'test-results/artifacts',
  use: {
    baseURL: BASE_URL,
    testIdAttribute: 'data-testid',
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } }],
});
