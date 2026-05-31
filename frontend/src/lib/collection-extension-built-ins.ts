import { activityExtensionEventViewRegistrar } from '$lib/activity-extension-views';
import { bidBookTraitDemandGroupPreviewRegistrar } from '$lib/bid-book-trait-previews';
import { registerTerraformsBidBookTraitPreviews } from '$lib/bid-book-trait-previews/terraforms';
import {
	registerTerraformsActivityExtensionViews,
	registerTerraformsCollectionNavigation
} from '$lib/activity-extension-views/terraforms';
import { collectionExtensionPageRegistrar } from '$lib/collection-extension-pages';
import { registerTerraformsCollectionExtensionPages } from '$lib/collection-extension-pages/terraforms';
import { collectionExtensionNavigationRegistrar } from '$lib/collection-extension-navigation';
import { registerTerraformsTokenDetailExtensionSections } from '$lib/token-detail-extension-sections/terraforms';
import { tokenDetailExtensionSectionRegistrar } from '$lib/token-detail-extension-sections';

let builtInCollectionExtensionsInstalled = false;

// Installs bundled collection extensions through the same frontend ports runtime extensions will use.
export function installBuiltInCollectionExtensions(): void {
	if (builtInCollectionExtensionsInstalled) return;
	builtInCollectionExtensionsInstalled = true;

	registerTerraformsActivityExtensionViews(activityExtensionEventViewRegistrar);
	registerTerraformsBidBookTraitPreviews(bidBookTraitDemandGroupPreviewRegistrar);
	registerTerraformsCollectionExtensionPages(collectionExtensionPageRegistrar);
	registerTerraformsCollectionNavigation(collectionExtensionNavigationRegistrar);
	registerTerraformsTokenDetailExtensionSections(tokenDetailExtensionSectionRegistrar);
}
