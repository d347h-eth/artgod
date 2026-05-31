import type { Component } from 'svelte';
import type { ApiCollectionExtensionSummary } from '$lib/api-types';
import type {
	BidBookTraitDemandGroupPreviewProps,
	BidBookTraitDemandGroupPreviewRegistrar,
	BidBookTraitDemandGroupPreviewRegistration
} from '$lib/bid-book-trait-previews/types';

export type {
	BidBookTraitDemandGroupPreviewProps
} from '$lib/bid-book-trait-previews/types';

const bidBookTraitDemandGroupPreviewsByExtension = new Map<
	string,
	BidBookTraitDemandGroupPreviewRegistration
>();

// Registers one extension-owned trait-bucket preview renderer.
export function registerBidBookTraitDemandGroupPreview(
	registration: BidBookTraitDemandGroupPreviewRegistration
): void {
	bidBookTraitDemandGroupPreviewsByExtension.set(registration.extensionKey, registration);
}

export const bidBookTraitDemandGroupPreviewRegistrar: BidBookTraitDemandGroupPreviewRegistrar = {
	registerBidBookTraitDemandGroupPreview
};

// Resolves a preview renderer for extensions enabled on the active collection.
export function resolveBidBookTraitDemandGroupPreview(
	collectionExtensions: readonly ApiCollectionExtensionSummary[]
): Component<BidBookTraitDemandGroupPreviewProps> | null {
	for (const extension of collectionExtensions) {
		const registration = bidBookTraitDemandGroupPreviewsByExtension.get(extension.key);
		if (registration) {
			return registration.Preview;
		}
	}
	return null;
}
