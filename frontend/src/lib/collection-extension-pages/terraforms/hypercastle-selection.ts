import {
	TERRAFORMS_HYPERCASTLE_LEVELS,
	type TerraformsLevelSummary
} from '@artgod/shared/extensions/terraforms';
import { withQuery } from '$lib/route-paths';

type ValueOf<T> = T[keyof T];

// Hypercastle selection scopes shared by the overview guide and detail panel.
export const TERRAFORMS_HYPERCASTLE_SELECTION_SCOPES = {
	AllLevels: 'all-levels'
} as const;

export type TerraformsHypercastleSelectionScope = ValueOf<
	typeof TERRAFORMS_HYPERCASTLE_SELECTION_SCOPES
>;

export type TerraformsHypercastleSelection = number | TerraformsHypercastleSelectionScope | null;

// Compact labels for Hypercastle selection controls and headings.
export const TERRAFORMS_HYPERCASTLE_SELECTION_LABELS = {
	AllLevels: 'All Levels',
	LevelPrefix: 'Level'
} as const;

// Query parameter names owned by the Terraforms Hypercastle page.
export const TERRAFORMS_HYPERCASTLE_SELECTION_QUERY_PARAMS = {
	Level: 'level'
} as const;

const TERRAFORMS_HYPERCASTLE_SELECTION_TITLE_SEPARATOR = ' ';
const TERRAFORMS_HYPERCASTLE_SELECTION_EMPTY_QUERY_VALUE = '';
const TERRAFORMS_HYPERCASTLE_SELECTION_LEVEL_VALUE_PATTERN = /^\d+$/;
const TERRAFORMS_HYPERCASTLE_SELECTION_DEFAULT_LEVELS = TERRAFORMS_HYPERCASTLE_LEVELS;

// Identifies the all-levels aggregate selection.
export function isTerraformsAllLevelsSelection(selection: TerraformsHypercastleSelection): boolean {
	return selection === TERRAFORMS_HYPERCASTLE_SELECTION_SCOPES.AllLevels;
}

// Identifies a concrete level-number selection.
export function resolveTerraformsSelectedLevelNumber(
	selection: TerraformsHypercastleSelection
): number | null {
	return typeof selection === 'number' ? selection : null;
}

// Formats the selected level heading.
export function formatTerraformsLevelTitle(levelNumber: number): string {
	return [TERRAFORMS_HYPERCASTLE_SELECTION_LABELS.LevelPrefix, String(levelNumber)].join(
		TERRAFORMS_HYPERCASTLE_SELECTION_TITLE_SEPARATOR
	);
}

// Parses URL state into a Hypercastle selection without accepting unknown levels.
export function parseTerraformsHypercastleRouteSelection(
	raw: string | null,
	levels: readonly TerraformsLevelSummary[] = TERRAFORMS_HYPERCASTLE_SELECTION_DEFAULT_LEVELS
): TerraformsHypercastleSelection {
	const value = raw?.trim().toLowerCase();
	if (!value) return null;
	if (value === TERRAFORMS_HYPERCASTLE_SELECTION_SCOPES.AllLevels) {
		return TERRAFORMS_HYPERCASTLE_SELECTION_SCOPES.AllLevels;
	}
	if (!TERRAFORMS_HYPERCASTLE_SELECTION_LEVEL_VALUE_PATTERN.test(value)) {
		return null;
	}
	const levelNumber = Number(value);
	return levels.some((level) => level.levelNumber === levelNumber) ? levelNumber : null;
}

// Serializes a Hypercastle selection into the route query value.
export function formatTerraformsHypercastleSelectionQueryValue(
	selection: TerraformsHypercastleSelection
): string | null {
	if (isTerraformsAllLevelsSelection(selection)) {
		return TERRAFORMS_HYPERCASTLE_SELECTION_SCOPES.AllLevels;
	}
	return typeof selection === 'number' ? String(selection) : null;
}

// Builds the current-page href after applying Hypercastle selection state.
export function buildTerraformsHypercastleSelectionHref(
	url: URL,
	selection: TerraformsHypercastleSelection
): string {
	const query = new URLSearchParams(url.searchParams);
	const queryValue = formatTerraformsHypercastleSelectionQueryValue(selection);
	if (queryValue) {
		query.set(TERRAFORMS_HYPERCASTLE_SELECTION_QUERY_PARAMS.Level, queryValue);
	} else {
		query.delete(TERRAFORMS_HYPERCASTLE_SELECTION_QUERY_PARAMS.Level);
	}
	return withQuery(url.pathname, query);
}

// Produces a stable comparison key for route-driven selection synchronization.
export function formatTerraformsHypercastleSelectionRouteKey(
	selection: TerraformsHypercastleSelection
): string {
	return (
		formatTerraformsHypercastleSelectionQueryValue(selection) ??
		TERRAFORMS_HYPERCASTLE_SELECTION_EMPTY_QUERY_VALUE
	);
}
