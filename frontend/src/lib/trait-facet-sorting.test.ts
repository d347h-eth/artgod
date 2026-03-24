import { describe, expect, it } from 'vitest';
import { sortTraitFacetValues } from './trait-facet-sorting';

describe('sortTraitFacetValues', () => {
	it('sorts by rarity ascending with alpha-numeric tiebreaks', () => {
		const values = sortTraitFacetValues(
			[
				{ value: '10', tokenCount: 2 },
				{ value: '2', tokenCount: 2 },
				{ value: '1', tokenCount: 1 }
			],
			'rarity'
		);

		expect(values.map((item) => item.value)).toEqual(['1', '2', '10']);
	});

	it('sorts alpha-numerically by trait value', () => {
		const values = sortTraitFacetValues(
			[
				{ value: 'Zone 10', tokenCount: 1 },
				{ value: 'Zone 2', tokenCount: 99 },
				{ value: 'Biome 1', tokenCount: 50 }
			],
			'alpha'
		);

		expect(values.map((item) => item.value)).toEqual(['Biome 1', 'Zone 2', 'Zone 10']);
	});
});
