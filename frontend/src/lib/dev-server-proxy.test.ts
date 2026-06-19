import { describe, expect, it } from 'vitest';
import { TOKEN_IMAGE_CACHE_PUBLIC_PATH_PREFIX } from '@artgod/shared/media/token-image-cache-paths';
import type { ConfigEnv, UserConfig } from 'vite';
import viteConfig from '../../vite.config';
import {
	buildFrontendDevProxy,
	DEFAULT_FRONTEND_DEV_BACKEND_ORIGIN,
	FRONTEND_DEV_PROXY_PATH
} from './dev-server-proxy';

describe('buildFrontendDevProxy', () => {
	it('proxies backend-owned media cache paths through the frontend dev origin', () => {
		const devBackendOrigin = DEFAULT_FRONTEND_DEV_BACKEND_ORIGIN;
		const proxy = buildFrontendDevProxy(devBackendOrigin);

		expect(FRONTEND_DEV_PROXY_PATH.TokenImages).toBe(TOKEN_IMAGE_CACHE_PUBLIC_PATH_PREFIX);
		expect(proxy[FRONTEND_DEV_PROXY_PATH.TokenImages]).toMatchObject({
			target: devBackendOrigin,
			changeOrigin: true
		});
	});

	it('keeps existing backend API and health paths on the same target', () => {
		const devBackendOrigin = DEFAULT_FRONTEND_DEV_BACKEND_ORIGIN;
		const proxy = buildFrontendDevProxy(devBackendOrigin);

		expect(proxy[FRONTEND_DEV_PROXY_PATH.Api]).toMatchObject({
			target: devBackendOrigin,
			changeOrigin: true
		});
		expect(proxy[FRONTEND_DEV_PROXY_PATH.Health]).toMatchObject({
			target: devBackendOrigin,
			changeOrigin: true
		});
	});

	it('wires the media cache proxy into the real Vite dev server config', () => {
		const config = resolveViteConfig({
			command: 'serve',
			mode: 'development',
			isSsrBuild: false,
			isPreview: false
		});

		expect(config.server?.proxy?.[FRONTEND_DEV_PROXY_PATH.TokenImages]).toMatchObject({
			target: DEFAULT_FRONTEND_DEV_BACKEND_ORIGIN,
			changeOrigin: true
		});
	});
});

function resolveViteConfig(env: ConfigEnv): UserConfig {
	const config = typeof viteConfig === 'function' ? viteConfig(env) : viteConfig;
	if (config instanceof Promise) {
		throw new Error('frontend vite config must resolve synchronously for dev proxy tests');
	}
	return config;
}
