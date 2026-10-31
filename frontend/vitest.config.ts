import svelteConfig from './sveltekit.config.js';
import { dependencyPrebundleOptions } from './vite-pnp-compat';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit(svelteConfig)],
	environments: {
		__vitest__: { optimizeDeps: dependencyPrebundleOptions }
	},
	test: {
		environment: 'node',
		include: ['src/**/*.{test,spec}.{js,ts}']
	}
});
