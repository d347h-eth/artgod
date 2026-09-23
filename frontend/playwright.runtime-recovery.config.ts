import { defineConfig } from 'playwright/test';
import { RECOVERY_HARNESS_PATH } from './src/lib/e2e/runtime-recovery-contract';

// A fresh project-local artifact directory preserves evidence from earlier runs.
const artifactRun = new Date().toISOString().replaceAll(':', '-');
const baseURL = 'http://127.0.0.1:42707';
export default defineConfig({
	testDir: './e2e',
	testMatch: ['runtime-recovery.spec.ts', 'listing-history.spec.ts'],
	outputDir: `../tmp/runtime-recovery-playwright/${artifactRun}`,
	timeout: 45_000,
	expect: { timeout: 10_000 },
	retries: 0,
	workers: 1,
	webServer: {
		command: 'yarn dev:e2e:runtime-recovery',
		url: `${baseURL}${RECOVERY_HARNESS_PATH}`,
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
			use: { browserName: 'chromium', viewport: { width: 768, height: 1024 } }
		},
		{
			name: 'admin-480x1024',
			use: { browserName: 'chromium', viewport: { width: 480, height: 1024 } }
		}
	]
});
