import { defineConfig, devices } from 'playwright/test';

const baseURL = process.env.ARTGOD_E2E_BASE_URL?.trim() || 'http://127.0.0.1:5173';
const persistSuccessArtifacts = process.env.ARTGOD_E2E_PERSIST_SUCCESS_ARTIFACTS === '1';

export default defineConfig({
	testDir: './e2e',
	outputDir: './test-results/playwright-attached',
	timeout: 45_000,
	expect: {
		timeout: 15_000
	},
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		trace: persistSuccessArtifacts ? 'on' : 'retain-on-failure',
		video: persistSuccessArtifacts ? 'on' : 'retain-on-failure',
		screenshot: persistSuccessArtifacts ? 'on' : 'only-on-failure'
	},
	projects: [
		{
			name: 'pixel-7',
			use: {
				browserName: 'chromium',
				viewport: { width: 412, height: 915 },
				screen: { width: 412, height: 915 },
				deviceScaleFactor: 2.625,
				isMobile: true,
				hasTouch: true,
				userAgent:
					'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
			}
		},
		{
			name: 'iphone-12-pro',
			use: {
				...devices['iPhone 12 Pro']
			}
		},
		{
			name: 'desktop-1080p',
			use: {
				browserName: 'chromium',
				viewport: { width: 1920, height: 1080 },
				screen: { width: 1920, height: 1080 }
			}
		},
		{
			name: 'desktop-1440p',
			use: {
				browserName: 'chromium',
				viewport: { width: 2560, height: 1440 },
				screen: { width: 2560, height: 1440 }
			}
		}
	]
});
