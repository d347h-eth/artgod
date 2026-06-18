import { defineConfig, devices } from 'playwright/test';
import { BOOTSTRAP_PROBE_E2E_ROUTE_PATH } from './src/lib/e2e/bootstrap-probe-fixtures';

const baseURL = process.env.COMMON_E2E_BASE_URL?.trim() || 'http://127.0.0.1:42705';
const readinessURL = `${baseURL}${BOOTSTRAP_PROBE_E2E_ROUTE_PATH}`;
const persistSuccessArtifacts = process.env.COMMON_E2E_PERSIST_SUCCESS_ARTIFACTS === '1';

export default defineConfig({
	testDir: './e2e',
	outputDir: './test-results/playwright-bootstrap-probe',
	timeout: 45_000,
	expect: {
		timeout: 10_000
	},
	fullyParallel: false,
	retries: 0,
	webServer: {
		command: 'yarn dev:e2e:bootstrap',
		url: readinessURL,
		reuseExistingServer: false,
		timeout: 120_000
	},
	use: {
		baseURL,
		trace: persistSuccessArtifacts ? 'on' : 'retain-on-failure',
		video: persistSuccessArtifacts ? 'on' : 'retain-on-failure',
		screenshot: persistSuccessArtifacts ? 'on' : 'only-on-failure'
	},
	projects: [
		{
			name: 'desktop-1080p',
			use: {
				browserName: 'chromium',
				viewport: { width: 1920, height: 1080 },
				screen: { width: 1920, height: 1080 }
			}
		},
		{
			name: 'pixel-7',
			use: {
				...devices['Pixel 7']
			}
		}
	]
});
