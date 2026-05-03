import { describe, expect, it } from 'vitest';
import {
	nextSelectedTraits,
	removeSelectedTrait,
	removeTraitRangeFilter
} from '$lib/trait-filters';

describe('nextSelectedTraits', () => {
	it('toggles trait values additively on plain click', () => {
		const next = nextSelectedTraits([{ key: 'Hat', value: 'Beanie' }], 'Hat', 'Cap', true, false);

		expect(next).toEqual([
			{ key: 'Hat', value: 'Beanie' },
			{ key: 'Hat', value: 'Cap' }
		]);
	});

	it('removes only the clicked trait value on plain uncheck', () => {
		const next = nextSelectedTraits(
			[
				{ key: 'Hat', value: 'Beanie' },
				{ key: 'Hat', value: 'Cap' }
			],
			'Hat',
			'Beanie',
			false,
			false
		);

		expect(next).toEqual([{ key: 'Hat', value: 'Cap' }]);
	});

	it('keeps only the clicked trait value on ctrl-click', () => {
		const next = nextSelectedTraits(
			[
				{ key: 'Hat', value: 'Beanie' },
				{ key: 'Hat', value: 'Cap' },
				{ key: 'Eyes', value: 'Blue' }
			],
			'Hat',
			'Cap',
			false,
			true
		);

		expect(next).toEqual([
			{ key: 'Hat', value: 'Cap' },
			{ key: 'Eyes', value: 'Blue' }
		]);
	});
});

describe('removeSelectedTrait', () => {
	it('removes only the matching selected key-value pair', () => {
		const next = removeSelectedTrait(
			[
				{ key: 'Hat', value: 'Beanie' },
				{ key: 'Hat', value: 'Cap' },
				{ key: 'Eyes', value: 'Blue' }
			],
			'Hat',
			'Beanie'
		);

		expect(next).toEqual([
			{ key: 'Hat', value: 'Cap' },
			{ key: 'Eyes', value: 'Blue' }
		]);
	});
});

describe('removeTraitRangeFilter', () => {
	it('removes only the matching selected range key', () => {
		const next = removeTraitRangeFilter(
			[
				{ key: 'Level', fromValue: '1', toValue: '10' },
				{ key: 'Seed', fromValue: '100', toValue: null }
			],
			'Level'
		);

		expect(next).toEqual([{ key: 'Seed', fromValue: '100', toValue: null }]);
	});
});
