import { activityExtensionEventViewRegistrar } from '$lib/activity-extension-views';
import { registerTerraformsActivityExtensionViews } from '$lib/activity-extension-views/terraforms';

let builtInActivityExtensionViewsInstalled = false;

// Installs bundled activity extension views through the same port runtime extensions will use.
export function installBuiltInActivityExtensionViews(): void {
	if (builtInActivityExtensionViewsInstalled) return;
	builtInActivityExtensionViewsInstalled = true;

	registerTerraformsActivityExtensionViews(activityExtensionEventViewRegistrar);
}
