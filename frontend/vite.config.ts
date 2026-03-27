import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { resolveProjectPath } from '@artgod/shared/utils/paths';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv, searchForWorkspaceRoot } from 'vite';

const frontendPackageJson = JSON.parse(
	readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
) as { version?: string };
const packageVersion = frontendPackageJson.version?.trim();

export default defineConfig(({ mode }) => {
	const workspaceRoot = searchForWorkspaceRoot(process.cwd());
	const fileEnv = loadEnv(mode, workspaceRoot, '');
	const resolvedEnv = {
		...fileEnv,
		...process.env
	};
	const appVersion = (resolvedEnv.PUBLIC_APP_VERSION?.trim() ||
		(packageVersion ? `v${packageVersion}` : 'v0.0.1-pre-alpha.2')) as string;
	const publicBackendOrigin = resolvedEnv.PUBLIC_BACKEND_ORIGIN?.trim() || '';
	const internalBackendOrigin = resolvedEnv.INTERNAL_BACKEND_ORIGIN?.trim() || '';
	const publicDeploymentMode = resolvedEnv.PUBLIC_APP_DEPLOYMENT_MODE?.trim() || '';
	const publicChainRef = resolvedEnv.PUBLIC_APP_CHAIN_REF?.trim() || '';
	const publicCollectionRef = resolvedEnv.PUBLIC_APP_COLLECTION_REF?.trim() || '';
	const devBackendOrigin =
		internalBackendOrigin || publicBackendOrigin || 'http://127.0.0.1:3000';

	return {
		plugins: [tailwindcss(), sveltekit()],
		envDir: resolveProjectPath('.'),
		define: {
			'import.meta.env.PUBLIC_APP_VERSION': JSON.stringify(appVersion),
			'import.meta.env.PUBLIC_BACKEND_ORIGIN': JSON.stringify(publicBackendOrigin),
			'import.meta.env.PUBLIC_APP_DEPLOYMENT_MODE': JSON.stringify(publicDeploymentMode),
			'import.meta.env.PUBLIC_APP_CHAIN_REF': JSON.stringify(publicChainRef),
			'import.meta.env.PUBLIC_APP_COLLECTION_REF': JSON.stringify(publicCollectionRef)
		},
		server: {
			fs: {
				allow: [workspaceRoot]
			},
			proxy: {
				'/api': {
					target: devBackendOrigin,
					changeOrigin: true
				},
				'/health': {
					target: devBackendOrigin,
					changeOrigin: true
				}
			}
		}
	};
});
