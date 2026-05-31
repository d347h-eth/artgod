import { TERRAFORMS_EXTENSION_KEY } from '@artgod/shared/extensions/terraforms';
import type { BidBookTraitDemandGroupPreviewRegistrar } from '$lib/bid-book-trait-previews/types';
import TerraformsBidBookTraitDemandPreview from '$lib/bid-book-trait-previews/terraforms/TerraformsBidBookTraitDemandPreview.svelte';

// Registers Terraforms previews for generic bid-book trait demand buckets.
export function registerTerraformsBidBookTraitPreviews(
	registrar: BidBookTraitDemandGroupPreviewRegistrar
): void {
	registrar.registerBidBookTraitDemandGroupPreview({
		extensionKey: TERRAFORMS_EXTENSION_KEY,
		Preview: TerraformsBidBookTraitDemandPreview
	});
}
