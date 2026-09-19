import { defineConfig } from 'playwright/test';
import { CONFIG_OBSERVABILITY_HARNESS } from './e2e/config-observability-harness.mjs';

const baseURL =
	process.env.ARTGOD_E2E_BASE_URL?.trim() ||
	`http://${CONFIG_OBSERVABILITY_HARNESS.host}:${CONFIG_OBSERVABILITY_HARNESS.port}`;

export default defineConfig({
	testDir: './e2e',
	outputDir: './test-results/playwright-config-observability',
	timeout: 45_000,
	expect: { timeout: 10_000 },
	fullyParallel: false,
	retries: 0,
	webServer: {
		command: 'yarn dev:e2e:config-observability',
		url: `${baseURL}${CONFIG_OBSERVABILITY_HARNESS.routePath}`,
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
