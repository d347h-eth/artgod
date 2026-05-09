import {
	isTerraformsDreamMode,
	TERRAFORMS_EXTENSION_KEY,
	TERRAFORMS_MODE_ATTRIBUTE_KEY
} from '@artgod/shared/extensions/terraforms';
import { TERRAFORMS_TOKEN_DETAIL_SECTION_IDS } from '$lib/activity-extension-views/terraforms/constants';
import TerraformsDreamsTokenSection from '$lib/token-detail-extension-sections/terraforms/TerraformsDreamsTokenSection.svelte';
import type {
	TokenDetailExtensionSectionContext,
	TokenDetailExtensionSectionRegistrar
} from '$lib/token-detail-extension-sections/types';

// Registers Terraforms token detail sections through the generic frontend extension port.
export function registerTerraformsTokenDetailExtensionSections(
	registrar: TokenDetailExtensionSectionRegistrar
): void {
	registrar.registerTokenDetailExtensionSection({
		extensionKey: TERRAFORMS_EXTENSION_KEY,
		sectionId: TERRAFORMS_TOKEN_DETAIL_SECTION_IDS.Dreams,
		Section: TerraformsDreamsTokenSection,
		isVisible: terraformsTokenCanShowDreamsSection
	});
}

function terraformsTokenCanShowDreamsSection(context: TokenDetailExtensionSectionContext): boolean {
	const mode = context.token.attributes.find(
		(attribute) => attribute.key === TERRAFORMS_MODE_ATTRIBUTE_KEY
	)?.value;
	return isTerraformsDreamMode(mode);
}
