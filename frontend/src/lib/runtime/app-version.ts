const injectedAppVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'v0.0.0-dev';
const rawVersion = String(injectedAppVersion).trim();

export const APP_VERSION = rawVersion.startsWith('v') ? rawVersion : `v${rawVersion}`;

// Injected from the checkout HEAD by Vite, then retained inside packaged assets.
export const APP_COMMIT = typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : '';
export const APP_SHORT_COMMIT = APP_COMMIT.slice(0, 7);
export const APP_ADMIN_VERSION = APP_SHORT_COMMIT
	? `${APP_VERSION} (${APP_SHORT_COMMIT})`
	: APP_VERSION;
