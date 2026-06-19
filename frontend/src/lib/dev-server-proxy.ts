import type { ProxyOptions } from 'vite';
import { TOKEN_IMAGE_CACHE_PUBLIC_PATH_PREFIX } from '@artgod/shared/media/token-image-cache-paths';

// Backend origin used by local frontend dev when env does not override it.
export const DEFAULT_FRONTEND_DEV_BACKEND_ORIGIN = 'http://127.0.0.1:42710';

// Route prefixes owned by the frontend dev server proxy.
export const FRONTEND_DEV_PROXY_PATH = {
	Api: '/api',
	Health: '/health',
	TokenImages: TOKEN_IMAGE_CACHE_PUBLIC_PATH_PREFIX
} as const;

// Builds Vite dev proxies for backend-owned paths that must share the browser origin.
export function buildFrontendDevProxy(devBackendOrigin: string): Record<string, ProxyOptions> {
	return {
		[FRONTEND_DEV_PROXY_PATH.Api]: {
			target: devBackendOrigin,
			changeOrigin: true
		},
		[FRONTEND_DEV_PROXY_PATH.Health]: {
			target: devBackendOrigin,
			changeOrigin: true
		},
		[FRONTEND_DEV_PROXY_PATH.TokenImages]: {
			target: devBackendOrigin,
			changeOrigin: true
		}
	};
}
