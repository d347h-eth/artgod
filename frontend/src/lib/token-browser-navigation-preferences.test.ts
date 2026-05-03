import { describe, expect, it } from 'vitest';
import {
	applyCollectionTokenNavigationPreferenceToQuery,
	buildCollectionTokenNavigationQuery,
	preferredCollectionTokensHref
} from '$lib/token-browser-navigation-preferences';

describe('applyCollectionTokenNavigationPreferenceToQuery', () => {
	it('adds stored token status when URL omits it', () => {
		expect(
			applyCollectionTokenNavigationPreferenceToQuery(
				'/ethereum/terraforms',
				new URLSearchParams('limit=25&mode=grid&traits=Mode%3ATerrain'),
				{ tokenStatus: 'all' }
			).toString()
		).toBe('limit=25&mode=grid&traits=Mode%3ATerrain&token_status=all');
	});

	it('keeps explicit URL token status ahead of stored values', () => {
		expect(
			applyCollectionTokenNavigationPreferenceToQuery(
				'/ethereum/terraforms',
				new URLSearchParams('token_status=listed'),
				{ tokenStatus: 'all' }
			).toString()
		).toBe('token_status=listed');
	});

	it('omits stored default token status from the generated URL', () => {
		expect(
			applyCollectionTokenNavigationPreferenceToQuery(
				'/ethereum/terraforms',
				new URLSearchParams('limit=25'),
				{ tokenStatus: 'listed' }
			).toString()
		).toBe('limit=25');
	});
});

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

describe('preferredCollectionTokensHref', () => {
	it('formats a structured collection tokens href from base path and query', () => {
		expect(
			preferredCollectionTokensHref({
				basePath: '/ethereum/terraforms',
				query: new URLSearchParams('limit=25&mode=grid')
			})
		).toBe('/ethereum/terraforms?limit=25&mode=grid');
	});
});
