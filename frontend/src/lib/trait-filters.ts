import type { ApiTokenAttribute } from '$lib/api-types';

export function appendTraitParams(
	params: URLSearchParams,
	selectedTraits: ApiTokenAttribute[] | null | undefined
): void {
	if (!selectedTraits) return;
	for (const trait of selectedTraits) {
		const key = trait.key.trim();
		const value = trait.value.trim();
		if (!key || !value) continue;
		params.append('traits', `${key}:${value}`);
	}
}

export function appendNormalizedTraitParams(
	params: URLSearchParams,
	raw: URLSearchParams
): void {
	const values = [...raw.getAll('traits'), ...raw.getAll('trait')];
	for (const value of values) {
		for (const segment of value.split(',')) {
			const trimmed = segment.trim();
			if (!trimmed) continue;
			params.append('traits', trimmed);
		}
	}
}

export function nextSelectedTraits(
	sourceTraits: ApiTokenAttribute[],
	key: string,
	value: string,
	checked: boolean,
	unionMode: boolean
): ApiTokenAttribute[] {
	const grouped = new Map<string, Set<string>>();
	for (const trait of sourceTraits) {
		const values = grouped.get(trait.key) ?? new Set<string>();
		values.add(trait.value);
		grouped.set(trait.key, values);
	}

	const current = grouped.get(key) ?? new Set<string>();
	if (unionMode) {
		if (checked) {
			current.add(value);
		} else {
			current.delete(value);
		}
		if (current.size === 0) {
			grouped.delete(key);
		} else {
			grouped.set(key, current);
		}
	} else {
		if (checked) {
			grouped.set(key, new Set([value]));
		} else {
			grouped.delete(key);
		}
	}

	const next: ApiTokenAttribute[] = [];
	for (const [groupKey, values] of grouped.entries()) {
		const sortedValues = [...values].sort((a, b) => a.localeCompare(b));
		for (const traitValue of sortedValues) {
			next.push({ key: groupKey, value: traitValue });
		}
	}
	return next;
}
