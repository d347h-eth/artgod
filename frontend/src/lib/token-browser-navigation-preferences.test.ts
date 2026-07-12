import { describe, expect, it } from 'vitest';
import {
	COLLECTION_MEDIA_MODES,
	COLLECTION_MEDIA_PREFERENCE_VALUES
} from '@artgod/shared/extensions';
import { buildCollectionTokenNavigationQuery } from '$lib/token-browser-navigation-preferences';

describe('buildCollectionTokenNavigationQuery', () => {
	it('builds collection token navigation query without an explicit token status', () => {
		expect(
			buildCollectionTokenNavigationQuery({
				limit: 25,
				displayMode: 'grid',
				selectedTraits: [{ key: 'Mode', value: 'Terrain' }],
				selectedTraitRanges: [],
				mediaMode: COLLECTION_MEDIA_MODES.Snapshot,
				mediaPreference: COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled
			}).toString()
		).toBe(
			'limit=25&mode=grid&media_mode=snapshot&media_preference=disabled&traits=Mode%3ATerrain'
		);
	});
});
