import { defineConfig } from 'playwright/test';
import collectionHarness from './playwright.bidding-automation.config';

const userland = process.env.ARTGOD_E2E_BUILT_USERLAND === '1';
const userlandPort = 42712;
const baseURL = userland ? 'http://127.0.0.1:' + userlandPort : collectionHarness.use?.baseURL;

export default defineConfig({
	...collectionHarness,
	testMatch: [
		'collection-views.spec.ts',
		'structured-traits.spec.ts',
		'plane-collection-ui.spec.ts'
	],
	outputDir: userland
		? '../tmp/collection-views-userland-playwright'
		: '../tmp/collection-views-playwright',
	use: { ...collectionHarness.use, baseURL },
	webServer: {
		command: userland
			? `yarn vite preview dist-userland --outDir . --host 127.0.0.1 --port ${userlandPort} --strictPort`
			: 'yarn dev:e2e:bidding',
		url: baseURL + '/e2e-harness/collection',
		reuseExistingServer: false,
		// Requests outside the browser fixture must never reach the operator's backend.
		env: { INTERNAL_BACKEND_ORIGIN: 'http://127.0.0.1:1' },
		timeout: 120_000
	},
	workers: 2,
	projects: [
		...(collectionHarness.projects ?? []),
		{
			name: 'desktop-1267',
			use: { browserName: 'chromium', viewport: { width: 1267, height: 712 } }
		}
	]
});
