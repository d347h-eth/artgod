import { readFileSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import { resolveProjectPath } from '@artgod/shared/utils/paths';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv, searchForWorkspaceRoot } from 'vite';

const rootPackageJson = JSON.parse(
	readFileSync(resolveProjectPath('package.json'), 'utf8')
) as { version?: string };
const rootVersion = rootPackageJson.version?.trim();

export default defineConfig(({ mode }) => {
	const workspaceRoot = searchForWorkspaceRoot(process.cwd());
	const fileEnv = loadEnv(mode, workspaceRoot, '');
	const resolvedEnv = {
		...fileEnv,
		...process.env
	};
	const appVersion = (rootVersion ? `v${rootVersion}` : 'v0.0.0-dev') as string;
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
			__APP_VERSION__: JSON.stringify(appVersion),
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
