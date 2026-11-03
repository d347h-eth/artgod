import { defineConfig } from 'playwright/test';
import attachedConfig from './playwright.attached.config';

const artifactRun = new Date().toISOString().replaceAll(':', '-');

export default defineConfig(attachedConfig, {
	testMatch: 'public-blockspace.attached.ts',
	outputDir: `../tmp/public-blockspace-attached/${artifactRun}`
});
