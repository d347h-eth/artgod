import { describe, expect, it } from 'vitest';
import {
	COLLECTION_MEDIA_MODES,
	COLLECTION_MEDIA_PREFERENCE_VALUES,
	COLLECTION_MEDIA_QUERY_PARAMS
} from '@artgod/shared/extensions';
import {
	appendCollectionMediaParams,
	buildTokenMediaQuery,
	nextMediaOption,
	normalizeMediaPreferenceValue
} from '$lib/media-mode';

describe('collection media query state', () => {
	it('omits a settled default preference and preserves explicit disabled state', () => {
		const defaultQuery = new URLSearchParams();
		appendCollectionMediaParams(defaultQuery, {
			mediaMode: COLLECTION_MEDIA_MODES.Snapshot,
			mediaPreference: {
				label: 'prefer modern media',
				enabled: true,
				defaultEnabled: true
			}
		});
		expect(defaultQuery.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaPreference)).toBeNull();

		const disabledQuery = new URLSearchParams();
		appendCollectionMediaParams(disabledQuery, {
			mediaMode: COLLECTION_MEDIA_MODES.Snapshot,
			mediaPreference: COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled
		});
		expect(disabledQuery.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaPreference)).toBe(
			COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled
		);
	});

	it('normalizes only owned preference values', () => {
		expect(normalizeMediaPreferenceValue(' DISABLED ')).toBe(
			COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled
		);
		expect(normalizeMediaPreferenceValue('unknown')).toBeNull();
	});

	it('keeps a token-local version separate from collection source state', () => {
		const query = buildTokenMediaQuery({
			mediaMode: COLLECTION_MEDIA_MODES.Snapshot,
			mediaPreference: COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled,
			mediaVariant: 'alternate-version'
		});

		expect(query.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode)).toBe(
			COLLECTION_MEDIA_MODES.Snapshot
		);
		expect(query.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaVariant)).toBe('alternate-version');
		expect(query.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaPreference)).toBe(
			COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled
		);
	});
});

describe('nextMediaOption', () => {
	it('cycles neutral media options without applying a source fallback', () => {
		const options = [
			{ key: 'modern', label: 'modern' },
			{ key: 'original', label: 'original' }
		];
		expect(nextMediaOption(options, 'modern')).toBe('original');
		expect(nextMediaOption([], 'current')).toBe('current');
	});
});
