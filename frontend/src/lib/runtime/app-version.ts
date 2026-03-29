const injectedAppVersion =
    typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'v0.0.0-dev';
const rawVersion = String(injectedAppVersion).trim();

export const APP_VERSION = rawVersion.startsWith('v') ? rawVersion : `v${rawVersion}`;
