import { activityExtensionEventViewRegistrar } from '$lib/activity-extension-views';
import {
	registerTerraformsActivityExtensionViews,
	registerTerraformsCollectionNavigation
} from '$lib/activity-extension-views/terraforms';
import { collectionExtensionNavigationRegistrar } from '$lib/collection-extension-navigation';
import { registerTerraformsTokenDetailExtensionSections } from '$lib/token-detail-extension-sections/terraforms';
import { tokenDetailExtensionSectionRegistrar } from '$lib/token-detail-extension-sections';

let builtInCollectionExtensionsInstalled = false;

// Installs bundled collection extensions through the same frontend ports runtime extensions will use.
export function installBuiltInCollectionExtensions(): void {
	if (builtInCollectionExtensionsInstalled) return;
	builtInCollectionExtensionsInstalled = true;

	registerTerraformsActivityExtensionViews(activityExtensionEventViewRegistrar);
	registerTerraformsCollectionNavigation(collectionExtensionNavigationRegistrar);
	registerTerraformsTokenDetailExtensionSections(tokenDetailExtensionSectionRegistrar);
}
