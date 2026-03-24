export type TraitFacetValue = {
	value: string;
	tokenCount: number;
};

export type TraitFacetValueSortMode = 'rarity' | 'alpha';

const TRAIT_VALUE_COLLATOR = new Intl.Collator(undefined, {
	numeric: true,
	sensitivity: 'base'
});

export function sortTraitFacetValues(
	values: TraitFacetValue[],
	mode: TraitFacetValueSortMode
): TraitFacetValue[] {
	const items = [...values];
	if (mode === 'alpha') {
		items.sort((left, right) => TRAIT_VALUE_COLLATOR.compare(left.value, right.value));
		return items;
	}

	items.sort((left, right) => {
		if (left.tokenCount !== right.tokenCount) {
			return left.tokenCount - right.tokenCount;
		}
		return TRAIT_VALUE_COLLATOR.compare(left.value, right.value);
	});
	return items;
}
