import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import {
	TERRAFORMS_EXTENSION_KEY,
	TERRAFORMS_EXTENSION_PAGE_REFS
} from '@artgod/shared/extensions/terraforms';
import type { PageLoad } from './$types';
import { buildTerraformsExtensionPageE2eData } from '$lib/e2e/terraforms-extension-page-fixtures';

export const ssr = false;

export const load: PageLoad = ({ params }) => {
	if (!dev) {
		throw error(404, 'Not found');
	}
	if (
		params.extension_key !== TERRAFORMS_EXTENSION_KEY ||
		params.page_ref !== TERRAFORMS_EXTENSION_PAGE_REFS.Hypercastle
	) {
		throw error(404, 'Not found');
	}

	// Feed deterministic extension-page data into the production collection page shell.
	return buildTerraformsExtensionPageE2eData();
};
