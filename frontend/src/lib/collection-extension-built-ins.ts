import { activityExtensionEventViewRegistrar } from '$lib/activity-extension-views';
import {
	registerTerraformsActivityExtensionViews,
	registerTerraformsCollectionNavigation
} from '$lib/activity-extension-views/terraforms';
import { collectionExtensionNavigationRegistrar } from '$lib/collection-extension-navigation';

let builtInCollectionExtensionsInstalled = false;

// Installs bundled collection extensions through the same frontend ports runtime extensions will use.
export function installBuiltInCollectionExtensions(): void {
	if (builtInCollectionExtensionsInstalled) return;
	builtInCollectionExtensionsInstalled = true;

	registerTerraformsActivityExtensionViews(activityExtensionEventViewRegistrar);
	registerTerraformsCollectionNavigation(collectionExtensionNavigationRegistrar);
}
