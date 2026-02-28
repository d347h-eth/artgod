// Keep web mode SSR-enabled by default; desktop build flips this so the app
// runs as a static SPA inside the desktop shell.
export const ssr = import.meta.env.VITE_FRONTEND_BUILD_TARGET !== 'desktop';
