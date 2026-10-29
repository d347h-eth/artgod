import svelteConfig from './sveltekit.config.js';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit(svelteConfig)],
	// Native Rolldown cannot resolve SvelteKit's generated tsconfig through PnP.
	// Dependency prebundles contain library code and need no app tsconfig.
	environments: {
		__vitest__: { optimizeDeps: { rolldownOptions: { tsconfig: false } } }
	},
	test: {
		environment: 'node',
		include: ['src/**/*.{test,spec}.{js,ts}']
	}
});
