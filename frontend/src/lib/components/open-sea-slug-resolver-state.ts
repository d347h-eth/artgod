// State emitted by the reusable OpenSea slug resolver control.
export type OpenSeaSlugResolverState = {
	slug: string;
	hasValue: boolean;
	resolvedSlug: string | null;
	resolved: boolean;
	incorrect: boolean;
	pending: boolean;
	message: string | null;
};
