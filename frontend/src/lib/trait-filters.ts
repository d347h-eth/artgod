import type { ApiTokenAttribute, ApiTraitRangeFilter } from '$lib/api-types';

export function parseSelectedTraits(raw: URLSearchParams): ApiTokenAttribute[] {
	const parsed: ApiTokenAttribute[] = [];
	const seen = new Set<string>();
	const values = [...raw.getAll('traits'), ...raw.getAll('trait')];

	for (const value of values) {
		for (const segment of value.split(',')) {
			const trimmed = segment.trim();
			if (!trimmed) continue;
			const delimiter = trimmed.indexOf(':');
			if (delimiter <= 0 || delimiter === trimmed.length - 1) continue;
			const key = trimmed.slice(0, delimiter).trim();
			const traitValue = trimmed.slice(delimiter + 1).trim();
			if (!key || !traitValue) continue;
			const signature = `${key}:${traitValue}`;
			if (seen.has(signature)) continue;
			seen.add(signature);
			parsed.push({ key, value: traitValue });
		}
	}

	return parsed.sort((left, right) =>
		left.key === right.key
			? left.value.localeCompare(right.value)
			: left.key.localeCompare(right.key)
	);
}

export function parseSelectedTraitRanges(raw: URLSearchParams): ApiTraitRangeFilter[] {
	const parsed: ApiTraitRangeFilter[] = [];
	const seen = new Set<string>();
	const values = [...raw.getAll('trait_ranges'), ...raw.getAll('trait_range')];

	for (const value of values) {
		for (const segment of value.split(',')) {
			const trimmed = segment.trim();
			if (!trimmed) continue;
			const delimiter = trimmed.indexOf(':');
			if (delimiter <= 0 || delimiter === trimmed.length - 1) continue;
			const key = trimmed.slice(0, delimiter).trim();
			const bounds = trimmed.slice(delimiter + 1).trim();
			const rangeDelimiter = bounds.indexOf('..');
			if (!key || rangeDelimiter < 0 || seen.has(key)) continue;
			const fromValue = bounds.slice(0, rangeDelimiter).trim() || null;
			const toValue = bounds.slice(rangeDelimiter + 2).trim() || null;
			if (fromValue === null && toValue === null) continue;
			if (fromValue !== null && !/^\d+$/.test(fromValue)) continue;
			if (toValue !== null && !/^\d+$/.test(toValue)) continue;
			if (fromValue !== null && toValue !== null && BigInt(fromValue) > BigInt(toValue)) continue;
			seen.add(key);
			parsed.push({ key, fromValue, toValue });
		}
	}

	return parsed.sort((left, right) => left.key.localeCompare(right.key));
}

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

export function appendTraitRangeParams(
	params: URLSearchParams,
	selectedRanges: ApiTraitRangeFilter[] | null | undefined
): void {
	if (!selectedRanges) return;
	for (const range of selectedRanges) {
		const key = range.key.trim();
		const fromValue = range.fromValue?.trim() || '';
		const toValue = range.toValue?.trim() || '';
		if (!key || (!fromValue && !toValue)) continue;
		params.append('trait_ranges', `${key}:${fromValue}..${toValue}`);
	}
}

export function appendNormalizedTraitRangeParams(
	params: URLSearchParams,
	raw: URLSearchParams
): void {
	const values = [...raw.getAll('trait_ranges'), ...raw.getAll('trait_range')];
	for (const value of values) {
		for (const segment of value.split(',')) {
			const trimmed = segment.trim();
			if (!trimmed) continue;
			params.append('trait_ranges', trimmed);
		}
	}
}

export function nextSelectedTraits(
	sourceTraits: ApiTokenAttribute[],
	key: string,
	value: string,
	checked: boolean,
	exclusiveMode: boolean
): ApiTokenAttribute[] {
	const grouped = new Map<string, Set<string>>();
	for (const trait of sourceTraits) {
		const values = grouped.get(trait.key) ?? new Set<string>();
		values.add(trait.value);
		grouped.set(trait.key, values);
	}

	const current = grouped.get(key) ?? new Set<string>();
	if (exclusiveMode) {
		grouped.set(key, new Set([value]));
	} else {
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

export function removeSelectedTrait(
	sourceTraits: ApiTokenAttribute[],
	key: string,
	value: string
): ApiTokenAttribute[] {
	return nextSelectedTraits(sourceTraits, key, value, false, false);
}

export function setTraitRangeFilter(
	sourceRanges: ApiTraitRangeFilter[],
	key: string,
	fromValue: string | null,
	toValue: string | null
): ApiTraitRangeFilter[] {
	const trimmedKey = key.trim();
	const normalizedFrom = fromValue?.trim() || null;
	const normalizedTo = toValue?.trim() || null;
	const next = sourceRanges.filter((range) => range.key !== trimmedKey);

	if (!trimmedKey || (normalizedFrom === null && normalizedTo === null)) {
		return next.sort((left, right) => left.key.localeCompare(right.key));
	}

	next.push({
		key: trimmedKey,
		fromValue: normalizedFrom,
		toValue: normalizedTo
	});
	return next.sort((left, right) => left.key.localeCompare(right.key));
}

export function removeTraitRangeFilter(
	sourceRanges: ApiTraitRangeFilter[],
	key: string
): ApiTraitRangeFilter[] {
	return setTraitRangeFilter(sourceRanges, key, null, null);
}
