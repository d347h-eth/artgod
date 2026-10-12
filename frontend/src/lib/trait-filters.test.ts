import { describe, expect, it } from 'vitest';
import {
	appendTraitParams,
	appendTraitRangeParams,
	canRepresentTraitFilters,
	nextSelectedTraits,
	parseSelectedTraits,
	parseSelectedTraitRanges,
	removeSelectedTrait,
	removeTraitRangeFilter
} from '$lib/trait-filters';

describe('trait filter query representability', () => {
	it.each([
		{ key: 'Palette', value: 'Red,Blue' },
		{ key: 'Trait:Kind', value: 'Rare' },
		{ key: 'Trait,Kind', value: 'Rare' },
		{ key: 'Palette', value: 'Red,Other:Blue' },
		{ key: 'Palette ', value: 'Red' },
		{ key: 'Palette', value: ' Red' },
		{ key: 'Palette', value: '\ud800' }
	])('rejects exact identity changed by the query round trip: %j', (trait) => {
		expect(canRepresentTraitFilters([trait], [])).toBe(false);
	});
	it.each(['Level,Height', 'Level:Height', ' Level'])(
		'rejects a range key changed by the query round trip: %s',
		(key) => {
			expect(canRepresentTraitFilters([], [{ key, fromValue: '1', toValue: '2' }])).toBe(false);
		}
	);
	it('preserves supported punctuation and criterion identity regardless of sort order', () => {
		const traits = [
			{ key: 'Palette', value: 'Red:Blue' },
			{ key: 'Art & Édition/%+?#', value: 'Rare + 50% & /? # 🟦' }
		];
		const ranges = [{ key: 'Level & Édition/%+?#', fromValue: '1', toValue: '2' }];
		expect(canRepresentTraitFilters(traits, ranges)).toBe(true);
		const query = new URLSearchParams();
		appendTraitParams(query, traits);
		appendTraitRangeParams(query, ranges);
		const decoded = new URLSearchParams(query.toString());
		expect(parseSelectedTraits(decoded)).toEqual([...traits].reverse());
		expect(parseSelectedTraitRanges(decoded)).toEqual(ranges);
	});
});

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
