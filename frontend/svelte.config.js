import adapterNode from '@sveltejs/adapter-node';
import adapterStatic from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const buildTarget = process.env.FRONTEND_BUILD_TARGET?.trim() || 'web';
const isAdminBuild = buildTarget === 'admin' || buildTarget === 'desktop';
const isUserlandBuild = buildTarget === 'userland';
const isStaticBuild = isAdminBuild || isUserlandBuild;
const staticOutDir = isAdminBuild ? 'dist' : 'dist-userland';

const config = {
	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	kit: {
		adapter: isStaticBuild
			? adapterStatic({
					pages: staticOutDir,
					assets: staticOutDir,
					fallback: 'index.html',
					strict: false
				})
			: adapterNode({
					out: 'build-web'
				})
	}
};

export default config;
