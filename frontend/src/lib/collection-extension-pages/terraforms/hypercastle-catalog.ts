import {
	TERRAFORMS_BIOMES,
	TERRAFORMS_HYPERCASTLE_LEVELS,
	TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS,
	TERRAFORMS_ZONES,
	type TerraformsBiome,
	type TerraformsBiomeGroupWeight,
	type TerraformsLevelGroupSummary,
	type TerraformsLevelSummary,
	type TerraformsZone
} from '@artgod/shared/extensions/terraforms';
import {
	TERRAFORMS_HYPERCASTLE_CATALOG_KEYS,
	TERRAFORMS_HYPERCASTLE_QUERY_PARAMS,
	TERRAFORMS_HYPERCASTLE_SORT_DIRECTIONS,
	TERRAFORMS_HYPERCASTLE_SORT_KEYS
} from '$lib/collection-extension-pages/terraforms/constants';
import { withQuery } from '$lib/route-paths';

export const TERRAFORMS_HYPERCASTLE_CATALOGS = [
	TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Levels,
	TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Zones,
	TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Biomes
] as const;

export type TerraformsHypercastleCatalog = (typeof TERRAFORMS_HYPERCASTLE_CATALOGS)[number];
export type TerraformsHypercastleSortDirection =
	(typeof TERRAFORMS_HYPERCASTLE_SORT_DIRECTIONS)[keyof typeof TERRAFORMS_HYPERCASTLE_SORT_DIRECTIONS];
export type TerraformsHypercastleSortKey =
	(typeof TERRAFORMS_HYPERCASTLE_SORT_KEYS)[keyof typeof TERRAFORMS_HYPERCASTLE_SORT_KEYS];

export type TerraformsHypercastleState = {
	selectedGroup: TerraformsLevelGroupSummary | null;
	selectedLevel: TerraformsLevelSummary | null;
	catalog: TerraformsHypercastleCatalog;
	sort: TerraformsHypercastleSortKey;
	direction: TerraformsHypercastleSortDirection;
};

export type TerraformsLevelCatalogRow = {
	level: TerraformsLevelSummary;
	group: TerraformsLevelGroupSummary;
	availableBiomeCount: number;
};

export type TerraformsZoneCatalogRow = {
	zone: TerraformsZone;
	levelNumbers: readonly number[];
	levelParcels: number;
	topographyBuckets: number;
};

export type TerraformsBiomeCatalogRow = {
	biome: TerraformsBiome;
	levelNumbers: readonly number[];
	levelParcels: number;
	maxWeightPercent: number;
	resourceCount: number;
};

export type TerraformsHypercastleHrefUpdate = {
	groupId?: string | null;
	levelNumber?: number | null;
	catalog?: TerraformsHypercastleCatalog | null;
	sort?: TerraformsHypercastleSortKey | null;
	direction?: TerraformsHypercastleSortDirection | null;
};

const DEFAULT_SORT_BY_CATALOG: Record<
	TerraformsHypercastleCatalog,
	TerraformsHypercastleSortKey
> = {
	[TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Levels]: TERRAFORMS_HYPERCASTLE_SORT_KEYS.Level,
	[TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Zones]: TERRAFORMS_HYPERCASTLE_SORT_KEYS.Index,
	[TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Biomes]: TERRAFORMS_HYPERCASTLE_SORT_KEYS.Index
};
const TERRAFORMS_RESOURCE_CHARACTER = '?';

// Resolves shareable query state for the Hypercastle explorer page.
export function resolveTerraformsHypercastleState(
	params: URLSearchParams
): TerraformsHypercastleState {
	const selectedLevel = parseLevelNumber(
		params.get(TERRAFORMS_HYPERCASTLE_QUERY_PARAMS.Level)
	);
	const requestedGroupId = params.get(TERRAFORMS_HYPERCASTLE_QUERY_PARAMS.Group);
	const catalog = normalizeTerraformsHypercastleCatalog(
		params.get(TERRAFORMS_HYPERCASTLE_QUERY_PARAMS.Catalog)
	);
	const sort = normalizeTerraformsHypercastleSort(
		catalog,
		params.get(TERRAFORMS_HYPERCASTLE_QUERY_PARAMS.Sort)
	);

	return {
		selectedLevel,
		selectedGroup: selectedLevel
			? findTerraformsLevelGroupForLevel(selectedLevel.levelNumber)
			: findTerraformsLevelGroupById(requestedGroupId),
		catalog,
		sort,
		direction: normalizeTerraformsHypercastleSortDirection(
			params.get(TERRAFORMS_HYPERCASTLE_QUERY_PARAMS.Direction)
		)
	};
}

// Builds a query href while keeping unrelated extension-page query state intact.
export function buildTerraformsHypercastleHref(
	pathname: string,
	currentParams: URLSearchParams,
	update: TerraformsHypercastleHrefUpdate
): string {
	const params = new URLSearchParams(currentParams);
	if (update.levelNumber !== undefined) {
		setOptionalParam(
			params,
			TERRAFORMS_HYPERCASTLE_QUERY_PARAMS.Level,
			update.levelNumber === null ? null : String(update.levelNumber)
		);
		const levelGroup =
			update.levelNumber === null
				? null
				: findTerraformsLevelGroupForLevel(update.levelNumber)?.groupId ?? null;
		setOptionalParam(params, TERRAFORMS_HYPERCASTLE_QUERY_PARAMS.Group, levelGroup);
	}
	if (update.groupId !== undefined) {
		setOptionalParam(params, TERRAFORMS_HYPERCASTLE_QUERY_PARAMS.Group, update.groupId);
		if (update.groupId !== null && update.levelNumber === undefined) {
			params.delete(TERRAFORMS_HYPERCASTLE_QUERY_PARAMS.Level);
		}
	}
	if (update.catalog !== undefined) {
		setOptionalParam(params, TERRAFORMS_HYPERCASTLE_QUERY_PARAMS.Catalog, update.catalog);
		if (update.catalog !== null && update.sort === undefined) {
			params.delete(TERRAFORMS_HYPERCASTLE_QUERY_PARAMS.Sort);
			params.delete(TERRAFORMS_HYPERCASTLE_QUERY_PARAMS.Direction);
		}
	}
	if (update.sort !== undefined) {
		setOptionalParam(params, TERRAFORMS_HYPERCASTLE_QUERY_PARAMS.Sort, update.sort);
	}
	if (update.direction !== undefined) {
		setOptionalParam(params, TERRAFORMS_HYPERCASTLE_QUERY_PARAMS.Direction, update.direction);
	}
	return withQuery(pathname, params);
}

export function findTerraformsLevelGroupById(
	groupId: string | null
): TerraformsLevelGroupSummary | null {
	if (!groupId) return null;
	return (
		TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS.find((group) => group.groupId === groupId) ?? null
	);
}

export function findTerraformsLevelGroupForLevel(
	levelNumber: number
): TerraformsLevelGroupSummary | null {
	return (
		TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS.find((group) =>
			group.levelNumbers.includes(levelNumber)
		) ?? null
	);
}

export function buildTerraformsLevelCatalogRows(): TerraformsLevelCatalogRow[] {
	return TERRAFORMS_HYPERCASTLE_LEVELS.map((level) => ({
		level,
		group: findTerraformsLevelGroupForLevel(level.levelNumber)!,
		availableBiomeCount: new Set(
			level.availableBiomeGroupWeights.flatMap((group) => group.biomeIndices)
		).size
	}));
}

export function buildTerraformsZoneCatalogRows(): TerraformsZoneCatalogRow[] {
	return TERRAFORMS_ZONES.map((zone) => {
		const levels = TERRAFORMS_HYPERCASTLE_LEVELS.filter((level) =>
			level.zones.some((levelZone) => levelZone.index === zone.index)
		);
		return {
			zone,
			levelNumbers: levels.map((level) => level.levelNumber),
			levelParcels: sum(levels.map((level) => level.parcelCount)),
			topographyBuckets: sum(
				levels.map(
					(level) =>
						level.topographyZoneBuckets.filter((bucket) => bucket.zoneIndex === zone.index)
							.length
				)
			)
		};
	});
}

export function buildTerraformsBiomeCatalogRows(): TerraformsBiomeCatalogRow[] {
	return TERRAFORMS_BIOMES.map((biome) => {
		const levelWeights = resolveBiomeLevelWeights(biome);
		const levels = TERRAFORMS_HYPERCASTLE_LEVELS.filter((level) =>
			levelWeights.some((entry) => entry.levelNumber === level.levelNumber)
		);
		return {
			biome,
			levelNumbers: levels.map((level) => level.levelNumber),
			levelParcels: sum(levels.map((level) => level.parcelCount)),
			maxWeightPercent: Math.max(0, ...levelWeights.map((entry) => entry.weight.weightPercent)),
			resourceCount: biome.characters.filter(
				(character) => character === TERRAFORMS_RESOURCE_CHARACTER
			).length
		};
	});
}

export function sortTerraformsLevelCatalogRows(
	rows: readonly TerraformsLevelCatalogRow[],
	sort: TerraformsHypercastleSortKey,
	direction: TerraformsHypercastleSortDirection
): TerraformsLevelCatalogRow[] {
	return [...rows].sort(compareRows(direction, (left, right) => {
		switch (sort) {
			case TERRAFORMS_HYPERCASTLE_SORT_KEYS.Parcels:
				return compareNumber(left.level.parcelCount, right.level.parcelCount);
			case TERRAFORMS_HYPERCASTLE_SORT_KEYS.Dimension:
				return compareNumber(left.level.dimension, right.level.dimension);
			case TERRAFORMS_HYPERCASTLE_SORT_KEYS.Zones:
				return compareNumber(left.level.zones.length, right.level.zones.length);
			case TERRAFORMS_HYPERCASTLE_SORT_KEYS.Biomes:
				return compareNumber(left.availableBiomeCount, right.availableBiomeCount);
			case TERRAFORMS_HYPERCASTLE_SORT_KEYS.Level:
			default:
				return compareNumber(left.level.levelNumber, right.level.levelNumber);
		}
	}));
}

export function sortTerraformsZoneCatalogRows(
	rows: readonly TerraformsZoneCatalogRow[],
	sort: TerraformsHypercastleSortKey,
	direction: TerraformsHypercastleSortDirection
): TerraformsZoneCatalogRow[] {
	return [...rows].sort(compareRows(direction, (left, right) => {
		switch (sort) {
			case TERRAFORMS_HYPERCASTLE_SORT_KEYS.Name:
				return left.zone.name.localeCompare(right.zone.name);
			case TERRAFORMS_HYPERCASTLE_SORT_KEYS.Levels:
				return compareNumber(left.levelNumbers.length, right.levelNumbers.length);
			case TERRAFORMS_HYPERCASTLE_SORT_KEYS.Parcels:
				return compareNumber(left.levelParcels, right.levelParcels);
			case TERRAFORMS_HYPERCASTLE_SORT_KEYS.Buckets:
				return compareNumber(left.topographyBuckets, right.topographyBuckets);
			case TERRAFORMS_HYPERCASTLE_SORT_KEYS.Index:
			default:
				return compareNumber(left.zone.index, right.zone.index);
		}
	}));
}

export function sortTerraformsBiomeCatalogRows(
	rows: readonly TerraformsBiomeCatalogRow[],
	sort: TerraformsHypercastleSortKey,
	direction: TerraformsHypercastleSortDirection
): TerraformsBiomeCatalogRow[] {
	return [...rows].sort(compareRows(direction, (left, right) => {
		switch (sort) {
			case TERRAFORMS_HYPERCASTLE_SORT_KEYS.Group:
				return compareNumber(left.biome.groupIndex, right.biome.groupIndex);
			case TERRAFORMS_HYPERCASTLE_SORT_KEYS.Levels:
				return compareNumber(left.levelNumbers.length, right.levelNumbers.length);
			case TERRAFORMS_HYPERCASTLE_SORT_KEYS.Parcels:
				return compareNumber(left.levelParcels, right.levelParcels);
			case TERRAFORMS_HYPERCASTLE_SORT_KEYS.Weight:
				return compareNumber(left.maxWeightPercent, right.maxWeightPercent);
			case TERRAFORMS_HYPERCASTLE_SORT_KEYS.Resource:
				return compareNumber(left.resourceCount, right.resourceCount);
			case TERRAFORMS_HYPERCASTLE_SORT_KEYS.Index:
			default:
				return compareNumber(left.biome.index, right.biome.index);
		}
	}));
}

function normalizeTerraformsHypercastleCatalog(
	value: string | null
): TerraformsHypercastleCatalog {
	return (
		TERRAFORMS_HYPERCASTLE_CATALOGS.find((catalog) => catalog === value) ??
		TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Levels
	);
}

function normalizeTerraformsHypercastleSort(
	catalog: TerraformsHypercastleCatalog,
	value: string | null
): TerraformsHypercastleSortKey {
	const validSorts = sortKeysForCatalog(catalog);
	return validSorts.includes(value as TerraformsHypercastleSortKey)
		? (value as TerraformsHypercastleSortKey)
		: DEFAULT_SORT_BY_CATALOG[catalog];
}

function normalizeTerraformsHypercastleSortDirection(
	value: string | null
): TerraformsHypercastleSortDirection {
	return value === TERRAFORMS_HYPERCASTLE_SORT_DIRECTIONS.Desc
		? TERRAFORMS_HYPERCASTLE_SORT_DIRECTIONS.Desc
		: TERRAFORMS_HYPERCASTLE_SORT_DIRECTIONS.Asc;
}

function sortKeysForCatalog(
	catalog: TerraformsHypercastleCatalog
): readonly TerraformsHypercastleSortKey[] {
	switch (catalog) {
		case TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Zones:
			return [
				TERRAFORMS_HYPERCASTLE_SORT_KEYS.Index,
				TERRAFORMS_HYPERCASTLE_SORT_KEYS.Name,
				TERRAFORMS_HYPERCASTLE_SORT_KEYS.Levels,
				TERRAFORMS_HYPERCASTLE_SORT_KEYS.Parcels,
				TERRAFORMS_HYPERCASTLE_SORT_KEYS.Buckets
			];
		case TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Biomes:
			return [
				TERRAFORMS_HYPERCASTLE_SORT_KEYS.Index,
				TERRAFORMS_HYPERCASTLE_SORT_KEYS.Group,
				TERRAFORMS_HYPERCASTLE_SORT_KEYS.Levels,
				TERRAFORMS_HYPERCASTLE_SORT_KEYS.Parcels,
				TERRAFORMS_HYPERCASTLE_SORT_KEYS.Weight,
				TERRAFORMS_HYPERCASTLE_SORT_KEYS.Resource
			];
		case TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Levels:
		default:
			return [
				TERRAFORMS_HYPERCASTLE_SORT_KEYS.Level,
				TERRAFORMS_HYPERCASTLE_SORT_KEYS.Parcels,
				TERRAFORMS_HYPERCASTLE_SORT_KEYS.Dimension,
				TERRAFORMS_HYPERCASTLE_SORT_KEYS.Zones,
				TERRAFORMS_HYPERCASTLE_SORT_KEYS.Biomes
			];
	}
}

function resolveBiomeLevelWeights(
	biome: TerraformsBiome
): { levelNumber: number; weight: TerraformsBiomeGroupWeight }[] {
	return TERRAFORMS_HYPERCASTLE_LEVELS.flatMap((level) => {
		const weight = level.availableBiomeGroupWeights.find(
			(group) => group.groupIndex === biome.groupIndex
		);
		return weight ? [{ levelNumber: level.levelNumber, weight }] : [];
	});
}

function parseLevelNumber(value: string | null): TerraformsLevelSummary | null {
	if (!value || !/^\d+$/.test(value)) return null;
	const levelNumber = Number.parseInt(value, 10);
	return (
		TERRAFORMS_HYPERCASTLE_LEVELS.find((level) => level.levelNumber === levelNumber) ?? null
	);
}

function setOptionalParam(params: URLSearchParams, key: string, value: string | null): void {
	if (value === null) {
		params.delete(key);
		return;
	}
	params.set(key, value);
}

function compareRows<T>(
	direction: TerraformsHypercastleSortDirection,
	compare: (left: T, right: T) => number
): (left: T, right: T) => number {
	return (left, right) => {
		const result = compare(left, right);
		return direction === TERRAFORMS_HYPERCASTLE_SORT_DIRECTIONS.Desc ? -result : result;
	};
}

function compareNumber(left: number, right: number): number {
	return left - right;
}

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}
