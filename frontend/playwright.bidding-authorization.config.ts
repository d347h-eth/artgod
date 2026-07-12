import { defineConfig } from 'playwright/test';

const baseURL = process.env.ARTGOD_E2E_BASE_URL?.trim() || 'http://127.0.0.1:42706';

export default defineConfig({
	testDir: './e2e',
	outputDir: './test-results/playwright-bidding-authorization',
	timeout: 45_000,
	expect: { timeout: 10_000 },
	fullyParallel: false,
	retries: 0,
	webServer: {
		command: 'yarn dev:e2e:bidding-authorization',
		url: `${baseURL}/e2e-harness/admin/bots`,
		reuseExistingServer: false,
		timeout: 120_000
	},
	use: {
		baseURL,
		trace: 'retain-on-failure',
		video: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	projects: [
		{
			name: 'admin-768x1024',
			use: {
				browserName: 'chromium',
				viewport: { width: 768, height: 1024 },
				screen: { width: 768, height: 1024 }
			}
		},
		{
			name: 'admin-narrow-480x1024',
			use: {
				browserName: 'chromium',
				viewport: { width: 480, height: 1024 },
				screen: { width: 480, height: 1024 }
			}
		}
	]
});
