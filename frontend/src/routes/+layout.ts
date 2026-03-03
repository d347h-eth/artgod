// Keep web mode SSR-enabled by default; admin/userland desktop builds run as static SPAs.
const target = (import.meta.env.VITE_FRONTEND_BUILD_TARGET as string | undefined)?.trim() ?? 'web';
export const ssr = target === 'web';
