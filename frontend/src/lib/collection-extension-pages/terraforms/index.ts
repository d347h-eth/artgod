import {
	TERRAFORMS_EXTENSION_KEY,
	TERRAFORMS_EXTENSION_PAGE_REFS
} from '@artgod/shared/extensions/terraforms';
import type { CollectionExtensionPageRegistrar } from '$lib/collection-extension-pages';
import { TERRAFORMS_EXTENSION_PAGE_LABELS } from '$lib/collection-extension-pages/terraforms/constants';
import TerraformsHypercastlePage from '$lib/collection-extension-pages/terraforms/TerraformsHypercastlePage.svelte';
import TerraformsHypercastleTopActions from '$lib/collection-extension-pages/terraforms/TerraformsHypercastleTopActions.svelte';

export { TERRAFORMS_EXTENSION_PAGE_LABELS } from '$lib/collection-extension-pages/terraforms/constants';

// Registers Terraforms collection pages through the generic frontend extension port.
export function registerTerraformsCollectionExtensionPages(
	registrar: CollectionExtensionPageRegistrar
): void {
	registrar.registerCollectionExtensionPage({
		extensionKey: TERRAFORMS_EXTENSION_KEY,
		pageRef: TERRAFORMS_EXTENSION_PAGE_REFS.Hypercastle,
		label: TERRAFORMS_EXTENSION_PAGE_LABELS.Hypercastle,
		Page: TerraformsHypercastlePage,
		TopActions: TerraformsHypercastleTopActions
	});
}
