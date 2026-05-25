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

const TERRAFORMS_HYPERCASTLE_SELECTION_TITLE_SEPARATOR = ' ';

// Identifies the all-levels aggregate selection.
export function isTerraformsAllLevelsSelection(
	selection: TerraformsHypercastleSelection
): boolean {
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
