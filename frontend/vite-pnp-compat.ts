// Dependency prebundles contain library code, not app source. Native Rolldown
// cannot discover SvelteKit's generated app tsconfig through Yarn PnP.
export const dependencyPrebundleOptions = {
	rolldownOptions: { tsconfig: false }
};
