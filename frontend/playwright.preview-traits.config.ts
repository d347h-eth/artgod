import { defineConfig } from 'playwright/test';
import biddingConfig from './playwright.bidding-automation.config';

// Reuse the production-component harness and preserve every run's evidence.
export default defineConfig({
	...biddingConfig,
	testMatch: 'preview-traits.spec.ts',
	outputDir: `../tmp/preview-traits-playwright/${new Date().toISOString().replaceAll(':', '-')}`,
	workers: 1
});
