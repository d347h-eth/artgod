const rawVersion =
	(import.meta.env.PUBLIC_APP_VERSION as string | undefined)?.trim() || 'v0.0.1-alpha';

export const APP_VERSION = rawVersion.startsWith('v') ? rawVersion : `v${rawVersion}`;
