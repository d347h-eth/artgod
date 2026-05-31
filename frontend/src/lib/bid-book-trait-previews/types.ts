import type { Component } from 'svelte';
import type { ApiBiddingBidBookRow } from '$lib/api-types';

// Props passed from the generic bid-book table into extension-owned trait previews.
export type BidBookTraitDemandGroupPreviewProps = {
	traits: ApiBiddingBidBookRow['scope']['traits'];
};

// Registration payload lets collection extensions customize trait-bucket previews.
export type BidBookTraitDemandGroupPreviewRegistration = {
	extensionKey: string;
	Preview: Component<BidBookTraitDemandGroupPreviewProps>;
};

// Registry port used by built-in and future runtime-loaded extension preview renderers.
export type BidBookTraitDemandGroupPreviewRegistrar = {
	registerBidBookTraitDemandGroupPreview: (
		registration: BidBookTraitDemandGroupPreviewRegistration
	) => void;
};
