type MaybePromise<T> = T | Promise<T>;

export type TraitFacetFilterModeOption = {
	value: string;
	label: string;
};

export type TraitFacetPanelControlActionInput = {
	hasActiveFilters: boolean;
	collapsed: boolean;
	onToggleCollapsed: () => MaybePromise<void>;
	onSetCollapsed?: ((collapsed: boolean) => MaybePromise<void>) | null;
	filterModes?: TraitFacetFilterModeOption[];
	selectedFilterMode?: string | null;
	onFilterModeChange?: ((value: string) => MaybePromise<void>) | null;
};

export async function runTraitFacetPanelControlAction(
	input: TraitFacetPanelControlActionInput
): Promise<void> {
	const filterModes = input.filterModes ?? [];
	const canCycleModes =
		filterModes.length > 1 &&
		input.selectedFilterMode !== null &&
		input.selectedFilterMode !== undefined &&
		input.onFilterModeChange !== null &&
		input.onFilterModeChange !== undefined;

	if (!canCycleModes || input.hasActiveFilters) {
		await input.onToggleCollapsed();
		return;
	}

	if (input.collapsed) {
		await setCollapsed(input, false);
		return;
	}

	const currentIndex = filterModes.findIndex((mode) => mode.value === input.selectedFilterMode);
	if (currentIndex >= 0 && currentIndex < filterModes.length - 1) {
		await input.onFilterModeChange?.(filterModes[currentIndex + 1].value);
		return;
	}

	await setCollapsed(input, true);
	await input.onFilterModeChange?.(filterModes[0].value);
}

async function setCollapsed(
	input: TraitFacetPanelControlActionInput,
	nextCollapsed: boolean
): Promise<void> {
	if (input.onSetCollapsed) {
		await input.onSetCollapsed(nextCollapsed);
		return;
	}
	await input.onToggleCollapsed();
}
