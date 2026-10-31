import { describe, expect, it } from 'vitest';
import {
	COLLECTION_MEDIA_MODES,
	COLLECTION_MEDIA_PREFERENCE_VALUES
} from '@artgod/shared/extensions';
import {
	buildCollectionCustomizationHref,
	COLLECTION_CUSTOMIZATION_SECTION
} from './customization-query';

describe('collection customization links', () => {
	it('adds the template section after preserved navigation query state', () => {
		const href = buildCollectionCustomizationHref({
			basePath: '/ethereum/collection',
			selectedTraits: [{ key: 'Color', value: 'Blue' }],
			selectedTraitRanges: [],
			mediaMode: COLLECTION_MEDIA_MODES.Snapshot,
			mediaPreference: COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled,
			section: COLLECTION_CUSTOMIZATION_SECTION.TokenCardTraitSummaryTemplate
		});
		const url = new URL(href, 'https://example.test');
		expect(url.pathname).toBe('/ethereum/collection/customization');
		expect(url.searchParams.get('traits')).toBe('Color:Blue');
		expect(url.searchParams.get('media_preference')).toBe(
			COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled
		);
		expect(url.hash).toBe(`#${COLLECTION_CUSTOMIZATION_SECTION.TokenCardTraitSummaryTemplate}`);
	});
});
