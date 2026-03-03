const FRONTEND_BUILD_TARGET =
	(import.meta.env.VITE_FRONTEND_BUILD_TARGET as string | undefined)?.trim() || 'web';

export const IS_ADMIN_FRONTEND_TARGET =
	FRONTEND_BUILD_TARGET === 'admin' || FRONTEND_BUILD_TARGET === 'desktop';

export const IS_USERLAND_FRONTEND_TARGET =
	FRONTEND_BUILD_TARGET === 'userland' || FRONTEND_BUILD_TARGET === 'web';

export function getFrontendBuildTarget(): string {
	return FRONTEND_BUILD_TARGET;
}
