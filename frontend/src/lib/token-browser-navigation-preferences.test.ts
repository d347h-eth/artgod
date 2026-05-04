import { describe, expect, it } from 'vitest';
import { buildCollectionTokenNavigationQuery } from '$lib/token-browser-navigation-preferences';

describe('buildCollectionTokenNavigationQuery', () => {
	it('builds collection token navigation query without an explicit token status', () => {
		expect(
			buildCollectionTokenNavigationQuery({
				limit: 25,
				displayMode: 'grid',
				selectedTraits: [{ key: 'Mode', value: 'Terrain' }],
				selectedTraitRanges: [],
				mediaMode: 'artifact'
			}).toString()
		).toBe('limit=25&mode=grid&media_mode=artifact&traits=Mode%3ATerrain');
	});
});
