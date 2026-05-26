import { describe, expect, it } from 'vitest';
import { COLLECTION_MEDIA_QUERY_PARAMS } from '@artgod/shared/extensions';
import {
	buildTerraformsHypercastleSelectionHref,
	formatTerraformsHypercastleSelectionQueryValue,
	parseTerraformsHypercastleRouteSelection,
	TERRAFORMS_HYPERCASTLE_SELECTION_QUERY_PARAMS,
	TERRAFORMS_HYPERCASTLE_SELECTION_SCOPES
} from '$lib/collection-extension-pages/terraforms/hypercastle-selection';

const TEST_HYPERCASTLE_URL = new URL(
	'https://artgod.test/extensions/terraforms/hypercastle?media_mode=snapshot'
);
const TEST_HYPERCASTLE_PATH = '/extensions/terraforms/hypercastle';
const TEST_MEDIA_MODE = 'snapshot';
const TEST_VALID_LEVEL = 12;
const TEST_UNKNOWN_LEVEL = 99;
const TEST_INVALID_SELECTION = 'nope';

describe('Terraforms Hypercastle selection routing', () => {
	it('parses route selection values into known Hypercastle selections', () => {
		expect(parseTerraformsHypercastleRouteSelection(String(TEST_VALID_LEVEL))).toBe(
			TEST_VALID_LEVEL
		);
		expect(
			parseTerraformsHypercastleRouteSelection(TERRAFORMS_HYPERCASTLE_SELECTION_SCOPES.AllLevels)
		).toBe(TERRAFORMS_HYPERCASTLE_SELECTION_SCOPES.AllLevels);
		expect(parseTerraformsHypercastleRouteSelection(String(TEST_UNKNOWN_LEVEL))).toBeNull();
		expect(parseTerraformsHypercastleRouteSelection(TEST_INVALID_SELECTION)).toBeNull();
	});

	it('serializes Hypercastle selections for URL query state', () => {
		expect(formatTerraformsHypercastleSelectionQueryValue(TEST_VALID_LEVEL)).toBe(
			String(TEST_VALID_LEVEL)
		);
		expect(
			formatTerraformsHypercastleSelectionQueryValue(
				TERRAFORMS_HYPERCASTLE_SELECTION_SCOPES.AllLevels
			)
		).toBe(TERRAFORMS_HYPERCASTLE_SELECTION_SCOPES.AllLevels);
		expect(formatTerraformsHypercastleSelectionQueryValue(null)).toBeNull();
	});

	it('builds current-page hrefs while preserving unrelated query state', () => {
		const levelHref = buildTerraformsHypercastleSelectionHref(
			TEST_HYPERCASTLE_URL,
			TEST_VALID_LEVEL
		);
		const levelUrl = new URL(levelHref, TEST_HYPERCASTLE_URL);

		expect(levelUrl.pathname).toBe(TEST_HYPERCASTLE_PATH);
		expect(levelUrl.searchParams.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode)).toBe(
			TEST_MEDIA_MODE
		);
		expect(levelUrl.searchParams.get(TERRAFORMS_HYPERCASTLE_SELECTION_QUERY_PARAMS.Level)).toBe(
			String(TEST_VALID_LEVEL)
		);

		const clearedHref = buildTerraformsHypercastleSelectionHref(levelUrl, null);
		const clearedUrl = new URL(clearedHref, TEST_HYPERCASTLE_URL);
		expect(clearedUrl.searchParams.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode)).toBe(
			TEST_MEDIA_MODE
		);
		expect(clearedUrl.searchParams.has(TERRAFORMS_HYPERCASTLE_SELECTION_QUERY_PARAMS.Level)).toBe(
			false
		);
	});
});
