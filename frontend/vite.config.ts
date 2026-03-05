import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, searchForWorkspaceRoot } from 'vite';

const frontendPackageJson = JSON.parse(
	readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
) as { version?: string };
const packageVersion = frontendPackageJson.version?.trim();
const appVersion = (process.env.PUBLIC_APP_VERSION?.trim() ||
	(packageVersion ? `v${packageVersion}` : 'v0.0.1-alpha')) as string;

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	define: {
		'import.meta.env.PUBLIC_APP_VERSION': JSON.stringify(appVersion)
	},
	server: {
		fs: {
			allow: [searchForWorkspaceRoot(process.cwd())]
		}
	}
});
