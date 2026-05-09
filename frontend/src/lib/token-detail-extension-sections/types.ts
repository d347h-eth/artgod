import type { Component } from 'svelte';
import type {
	ApiActivityExtensionEventRef,
	ApiChain,
	ApiCollection,
	ApiCollectionMediaState,
	ApiTokenDetail
} from '$lib/api-types';

// Token detail activity filters let extension sections deep-link into extension event feeds.
export type TokenDetailExtensionActivityFilters = {
	tokenId?: string | null;
	maker?: string | null;
	contentHash?: string | null;
};

// Link builders let token detail sections navigate without importing route construction details.
export type TokenDetailExtensionSectionHrefs = {
	activityExtensionEvent: (
		event: ApiActivityExtensionEventRef,
		filters?: TokenDetailExtensionActivityFilters
	) => string;
};

// Shared token detail context used for visibility checks before rendering extension sections.
export type TokenDetailExtensionSectionContext = {
	chain: ApiChain;
	collection: ApiCollection;
	token: ApiTokenDetail;
	media: ApiCollectionMediaState;
};

// Component props passed from the token detail page into extension-owned sections.
export type TokenDetailExtensionSectionProps = TokenDetailExtensionSectionContext & {
	hrefs: TokenDetailExtensionSectionHrefs;
};

// Registration payload binds an extension-owned section to the token detail page surface.
export type TokenDetailExtensionSectionRegistration = {
	extensionKey: string;
	sectionId: string;
	order?: number;
	Section: Component<TokenDetailExtensionSectionProps>;
	isVisible?: (context: TokenDetailExtensionSectionContext) => boolean;
};

// Resolved sections are ready for the token detail page to render in display order.
export type TokenDetailExtensionSection = {
	extensionKey: string;
	sectionId: string;
	Section: Component<TokenDetailExtensionSectionProps>;
};

// Registry port lets embedded and future runtime-loaded extensions publish token detail sections.
export type TokenDetailExtensionSectionRegistrar = {
	registerTokenDetailExtensionSection: (
		registration: TokenDetailExtensionSectionRegistration
	) => void;
};
