export type TraitFacetValue = {
	value: string;
	tokenCount: number;
};

export type TraitFacetValueSortMode = 'rarity' | 'alpha';

export const compareTraitLabels = new Intl.Collator(undefined, {
	numeric: true,
	sensitivity: 'base'
}).compare;

export function sortTraitFacetValues(
	values: TraitFacetValue[],
	mode: TraitFacetValueSortMode
): TraitFacetValue[] {
	const items = [...values];
	if (mode === 'alpha') {
		items.sort((left, right) => compareTraitLabels(left.value, right.value));
		return items;
	}

	items.sort((left, right) => {
		if (left.tokenCount !== right.tokenCount) {
			return left.tokenCount - right.tokenCount;
		}
		return compareTraitLabels(left.value, right.value);
	});
	return items;
}
