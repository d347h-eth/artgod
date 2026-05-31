<script lang="ts">
	import { browser } from '$app/environment';
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy, onMount } from 'svelte';
	import type { CollectionExtensionPageProps } from '$lib/collection-extension-pages/types';
	import TerraformsHypercastleOverview from '$lib/collection-extension-pages/terraforms/TerraformsHypercastleOverview.svelte';
	import TerraformsTraitTable from '$lib/collection-extension-pages/terraforms/TerraformsTraitTable.svelte';
	import CheckIcon from '$lib/components/CheckIcon.svelte';
	import CopyIcon from '$lib/components/CopyIcon.svelte';
	import {
		applyTerraformsBiomeTokenCounts,
		buildTerraformsBiomeRows,
		buildTerraformsBiomeTokenHref,
		formatTerraformsBiomeCharacterLabel,
		formatTerraformsBiomeMintedTokenCount,
		formatTerraformsBiomeSortLabel,
		formatTerraformsBiomeTokenLabel,
		resolveTerraformsBiomeAriaSort,
		resolveTerraformsBiomeDefaultSortDirection,
		resolveTerraformsBiomePreviewBackgroundColor,
		resolveTerraformsBiomePreviewCharacterColor,
		sortTerraformsBiomeRows,
		TERRAFORMS_BIOME_TABLE_DOM,
		TERRAFORMS_BIOME_TABLE_COLUMNS,
		TERRAFORMS_BIOME_TABLE_COLUMNS_ORDER,
		TERRAFORMS_BIOME_TABLE_LABELS,
		toggleTerraformsBiomeSortDirection,
		defaultTerraformsBiomeSortColumn,
		defaultTerraformsBiomeSortDirection,
		type TerraformsBiomeSortDirection,
		type TerraformsBiomeTableColumn
	} from '$lib/collection-extension-pages/terraforms/biomes';
	import { TERRAFORMS_HYPERCASTLE_PAGE_ACTIONS } from '$lib/collection-extension-pages/terraforms/hypercastle-actions';
	import {
		applyTerraformsLevelZoneTokenCounts,
		buildTerraformsAllLevelZoneRows,
		buildTerraformsLevelZoneRows,
		buildTerraformsZoneTokenHref,
		defaultTerraformsLevelZoneSortColumn,
		defaultTerraformsLevelZoneSortDirection,
		defaultTerraformsSelectedLevelZoneSortColumn,
		defaultTerraformsSelectedLevelZoneSortDirection,
		formatTerraformsLevelZoneSortLabel,
		formatTerraformsZoneMintedTokenCount,
		formatTerraformsZonePaletteCopyLabel,
		formatTerraformsZonePaletteCopyValue,
		formatTerraformsZonePaletteSwatchLabel,
		formatTerraformsZoneTokenFilterLabel,
		resolveTerraformsHypercastleLevel,
		resolveTerraformsLevelZoneAriaSort,
		resolveTerraformsLevelZoneDefaultSortDirection,
		sortTerraformsLevelZoneRows,
		toggleTerraformsLevelZoneSortDirection,
		TERRAFORMS_LEVEL_ZONE_BUTTON_TYPES,
		TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_FEEDBACK_DELAY_MS,
		TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_STATES,
		TERRAFORMS_LEVEL_ZONE_SECTION_LABELS,
		TERRAFORMS_LEVEL_ZONE_TABLE_COLUMN_SETS,
		TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS,
		TERRAFORMS_LEVEL_ZONE_TABLE_DOM,
		TERRAFORMS_LEVEL_ZONE_TABLE_LABELS,
		type TerraformsLevelZonePaletteCopyState,
		type TerraformsLevelZoneRow,
		type TerraformsLevelZoneSortDirection,
		type TerraformsLevelZoneTableColumn
	} from '$lib/collection-extension-pages/terraforms/level-zones';
	import {
		buildTerraformsHypercastleSelectionHref,
		formatTerraformsHypercastleSelectionRouteKey,
		formatTerraformsLevelTitle,
		isTerraformsAllLevelsSelection,
		parseTerraformsHypercastleRouteSelection,
		resolveTerraformsSelectedLevelNumber,
		TERRAFORMS_HYPERCASTLE_SELECTION_LABELS,
		TERRAFORMS_HYPERCASTLE_SELECTION_QUERY_PARAMS,
		TERRAFORMS_HYPERCASTLE_SELECTION_SCOPES,
		type TerraformsHypercastleSelection
	} from '$lib/collection-extension-pages/terraforms/hypercastle-selection';
	import {
		buildTerraformsHypercastleLevelSurfaces,
		replaceTerraformsHypercastleLevelSurface
	} from '$lib/collection-extension-pages/terraforms/hypercastle-surface-texture';
	import {
		buildTerraformsTraitCatalogRequestKey,
		fetchTerraformsHypercastleTraitCounts,
		TERRAFORMS_HYPERCASTLE_EMPTY_TRAIT_COUNTS,
		type TerraformsHypercastleTraitCounts
	} from '$lib/collection-extension-pages/terraforms/trait-catalog-counts';

	const TERRAFORMS_HYPERCASTLE_BROWSER_EVENTS = {
		PageShow: 'pageshow',
		PopState: 'popstate'
	} as const;

	let { actions, basePath, chain, collection, media }: CollectionExtensionPageProps = $props();

	let selection = $state<TerraformsHypercastleSelection>(null);
	let zoneSortColumn = $state<TerraformsLevelZoneTableColumn>(
		defaultTerraformsLevelZoneSortColumn()
	);
	let zoneSortDirection = $state<TerraformsLevelZoneSortDirection>(
		defaultTerraformsLevelZoneSortDirection()
	);
	let biomeSortColumn = $state<TerraformsBiomeTableColumn>(defaultTerraformsBiomeSortColumn());
	let biomeSortDirection = $state<TerraformsBiomeSortDirection>(
		defaultTerraformsBiomeSortDirection()
	);
	let levelSurfaces = $state(buildTerraformsHypercastleLevelSurfaces());
	let paletteCopyStates = $state<Record<string, TerraformsLevelZonePaletteCopyState>>({});
	let paletteCopyFeedbackTimer: number | null = null;
	let biomePreviewPalette = $state<readonly string[] | null>(null);
	let traitCounts = $state<TerraformsHypercastleTraitCounts>(
		TERRAFORMS_HYPERCASTLE_EMPTY_TRAIT_COUNTS
	);
	let traitCountsLoaded = $state(false);
	let traitCountsRequestKey: string | null = $state(null);
	let appliedRouteSelectionKey: string | null = $state(null);
	let pendingLocalSelectionKey: string | null = $state(null);
	let routeSelection = $derived(
		parseTerraformsHypercastleRouteSelection(
			page.url.searchParams.get(TERRAFORMS_HYPERCASTLE_SELECTION_QUERY_PARAMS.Level)
		)
	);
	let routeSelectionKey = $derived(formatTerraformsHypercastleSelectionRouteKey(routeSelection));
	let selectedLevelNumber = $derived(resolveTerraformsSelectedLevelNumber(selection));
	let allLevelsSelected = $derived(isTerraformsAllLevelsSelection(selection));
	let selectedLevel = $derived(resolveTerraformsHypercastleLevel(selectedLevelNumber));
	let zoneTableColumns: readonly TerraformsLevelZoneTableColumn[] = $derived(
		allLevelsSelected
			? TERRAFORMS_LEVEL_ZONE_TABLE_COLUMN_SETS.AllLevels
			: selectedLevel
				? TERRAFORMS_LEVEL_ZONE_TABLE_COLUMN_SETS.SelectedLevel
				: []
	);
	let activeZoneSortColumn = $derived(resolveActiveZoneSortColumn(zoneTableColumns, zoneSortColumn));
	let zoneRows = $derived(
		sortTerraformsLevelZoneRows(
			applyTerraformsLevelZoneTokenCounts(
				allLevelsSelected
					? buildTerraformsAllLevelZoneRows()
					: selectedLevel
						? buildTerraformsLevelZoneRows(selectedLevel)
						: [],
				traitCounts.zoneTokenCounts,
				traitCountsLoaded,
				{ mintedOnly: !allLevelsSelected }
			),
			activeZoneSortColumn,
			zoneSortDirection
		)
	);
	let detailTitle = $derived(resolveDetailTitle(selection, selectedLevelNumber));
	let showZoneTable = $derived(detailTitle !== null && zoneRows.length > 0);
	let biomeRows = $derived(
		sortTerraformsBiomeRows(
			applyTerraformsBiomeTokenCounts(
				buildTerraformsBiomeRows(),
				traitCounts.biomeTokenCounts,
				traitCountsLoaded,
				{ mintedOnly: !allLevelsSelected }
			),
			biomeSortColumn,
			biomeSortDirection
		)
	);
	let showBiomeTable = $derived(detailTitle !== null && biomeRows.length > 0);
	let showDetailTitle = $derived(detailTitle !== null && !allLevelsSelected);
	let biomePreviewBackgroundColor = $derived(
		resolveTerraformsBiomePreviewBackgroundColor(biomePreviewPalette)
	);

	afterNavigate(() => {
		syncSelectionFromCurrentLocation();
	});

	onMount(() => {
		syncSelectionFromCurrentLocation();
		window.addEventListener(
			TERRAFORMS_HYPERCASTLE_BROWSER_EVENTS.PopState,
			syncSelectionFromCurrentLocation
		);
		window.addEventListener(
			TERRAFORMS_HYPERCASTLE_BROWSER_EVENTS.PageShow,
			syncSelectionFromCurrentLocation
		);
		return () => {
			window.removeEventListener(
				TERRAFORMS_HYPERCASTLE_BROWSER_EVENTS.PopState,
				syncSelectionFromCurrentLocation
			);
			window.removeEventListener(
				TERRAFORMS_HYPERCASTLE_BROWSER_EVENTS.PageShow,
				syncSelectionFromCurrentLocation
			);
		};
	});

	onDestroy(() => {
		if (paletteCopyFeedbackTimer !== null) {
			window.clearTimeout(paletteCopyFeedbackTimer);
		}
	});

	$effect(() => {
		// Expose surface rerolling to the shared collection-page top-action row.
		return actions.registerAction(
			TERRAFORMS_HYPERCASTLE_PAGE_ACTIONS.RerollSurfaces,
			rerollAllLevelSurfaces
		);
	});

	$effect(() => {
		// Keep minted counts aligned with the selected Hypercastle scope.
		if (!browser) return;
		const nextRequestKey = buildTerraformsTraitCatalogRequestKey({
			chainRef: chain.slug,
			collectionRef: collection.slug,
			levelNumber: selectedLevelNumber
		});
		if (nextRequestKey === traitCountsRequestKey) return;
		traitCountsRequestKey = nextRequestKey;
		traitCounts = TERRAFORMS_HYPERCASTLE_EMPTY_TRAIT_COUNTS;
		traitCountsLoaded = false;
		void loadTraitCounts(nextRequestKey, selectedLevelNumber);
	});

	$effect(() => {
		// Keep browser back/forward and direct URLs aligned with the selected Hypercastle scope.
		if (pendingLocalSelectionKey !== null) {
			if (routeSelectionKey === pendingLocalSelectionKey) {
				appliedRouteSelectionKey = routeSelectionKey;
				pendingLocalSelectionKey = null;
			}
			return;
		}
		const currentSelectionKey = formatTerraformsHypercastleSelectionRouteKey(selection);
		if (routeSelectionKey === appliedRouteSelectionKey && routeSelectionKey === currentSelectionKey) {
			return;
		}
		appliedRouteSelectionKey = routeSelectionKey;
		if (routeSelectionKey === currentSelectionKey) return;
		applySelectionState(routeSelection);
	});

	function selectLevel(levelNumber: number): void {
		applySelectionState(levelNumber);
		navigateToSelection(levelNumber);
	}

	function selectAllLevels(): void {
		const nextSelection = TERRAFORMS_HYPERCASTLE_SELECTION_SCOPES.AllLevels;
		applySelectionState(nextSelection);
		navigateToSelection(nextSelection);
	}

	function applySelectionState(nextSelection: TerraformsHypercastleSelection): void {
		selection = nextSelection;
		biomePreviewPalette = null;
		biomeSortColumn = defaultTerraformsBiomeSortColumn();
		biomeSortDirection = defaultTerraformsBiomeSortDirection();
		if (typeof nextSelection === 'number') {
			zoneSortColumn = defaultTerraformsSelectedLevelZoneSortColumn();
			zoneSortDirection = defaultTerraformsSelectedLevelZoneSortDirection();
			return;
		}
		zoneSortColumn = defaultTerraformsLevelZoneSortColumn();
		zoneSortDirection = defaultTerraformsLevelZoneSortDirection();
	}

	function navigateToSelection(nextSelection: TerraformsHypercastleSelection): void {
		if (!browser) return;
		const href = buildTerraformsHypercastleSelectionHref(page.url, nextSelection);
		if (href === buildTerraformsHypercastleSelectionHref(page.url, routeSelection)) return;
		pendingLocalSelectionKey = formatTerraformsHypercastleSelectionRouteKey(nextSelection);
		void goto(href, {
			keepFocus: true,
			noScroll: true
		});
	}

	function syncSelectionFromCurrentLocation(): void {
		const nextSelection = parseTerraformsHypercastleRouteSelection(
			new URL(window.location.href).searchParams.get(
				TERRAFORMS_HYPERCASTLE_SELECTION_QUERY_PARAMS.Level
			)
		);
		const nextSelectionKey = formatTerraformsHypercastleSelectionRouteKey(nextSelection);
		const currentSelectionKey = formatTerraformsHypercastleSelectionRouteKey(selection);
		appliedRouteSelectionKey = nextSelectionKey;
		pendingLocalSelectionKey = null;
		if (nextSelectionKey === currentSelectionKey) return;
		applySelectionState(nextSelection);
	}

	function rerollAllLevelSurfaces(): void {
		levelSurfaces = buildTerraformsHypercastleLevelSurfaces();
	}

	async function loadTraitCounts(requestKey: string, levelNumber: number | null): Promise<void> {
		try {
			const nextTraitCounts = await fetchTerraformsHypercastleTraitCounts({
				fetch,
				chainRef: chain.slug,
				collectionRef: collection.slug,
				levelNumber
			});
			if (traitCountsRequestKey !== requestKey) return;
			traitCounts = nextTraitCounts;
			traitCountsLoaded = true;
		} catch {
			if (traitCountsRequestKey !== requestKey) return;
			traitCounts = TERRAFORMS_HYPERCASTLE_EMPTY_TRAIT_COUNTS;
			traitCountsLoaded = false;
		}
	}

	function applyZoneSurface(zoneIndex: number): void {
		if (selectedLevelNumber === null) return;
		levelSurfaces = replaceTerraformsHypercastleLevelSurface({
			surfaces: levelSurfaces,
			levelNumber: selectedLevelNumber,
			zoneIndex
		});
	}

	function applyZonePalette(row: TerraformsLevelZoneRow): void {
		if (selectedLevelNumber === null) return;
		biomePreviewPalette = row.palette;
		applyZoneSurface(row.zoneIndex);
	}

	function resetBiomePreviewColors(): void {
		biomePreviewPalette = null;
	}

	async function copyZonePalette(row: TerraformsLevelZoneRow): Promise<void> {
		if (!browser) return;
		try {
			await navigator.clipboard.writeText(formatTerraformsZonePaletteCopyValue(row));
			setPaletteCopyState(row.key, TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_STATES.Copied);
			resetPaletteCopyFeedbackLater(row.key);
		} catch {
			setPaletteCopyState(row.key, TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_STATES.Failed);
			resetPaletteCopyFeedbackLater(row.key);
		}
	}

	function setPaletteCopyState(
		rowKey: string,
		state: TerraformsLevelZonePaletteCopyState
	): void {
		paletteCopyStates = {
			...paletteCopyStates,
			[rowKey]: state
		};
	}

	function resetPaletteCopyFeedbackLater(rowKey: string): void {
		if (paletteCopyFeedbackTimer !== null) {
			window.clearTimeout(paletteCopyFeedbackTimer);
		}
		paletteCopyFeedbackTimer = window.setTimeout(() => {
			const nextCopyStates = { ...paletteCopyStates };
			delete nextCopyStates[rowKey];
			paletteCopyStates = nextCopyStates;
			paletteCopyFeedbackTimer = null;
		}, TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_FEEDBACK_DELAY_MS);
	}

	function paletteCopyState(rowKey: string): TerraformsLevelZonePaletteCopyState {
		return paletteCopyStates[rowKey] ?? TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_STATES.Idle;
	}

	function paletteCopyButtonClass(rowKey: string): string {
		const state = paletteCopyState(rowKey);
		const classNames: string[] = [TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.paletteCopyButton];
		if (state === TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_STATES.Copied) {
			classNames.push(TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.paletteCopyButtonCopied);
		}
		if (state === TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_STATES.Failed) {
			classNames.push(TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.paletteCopyButtonFailed);
		}
		return classNames.join(' ');
	}

	function zoneTokenHref(row: TerraformsLevelZoneRow): string {
		return buildTerraformsZoneTokenHref({
			basePath,
			mediaMode: media.selectedMode,
			zoneName: row.name
		});
	}

	function biomeTokenHref(biomeIndex: number): string {
		return buildTerraformsBiomeTokenHref({
			basePath,
			mediaMode: media.selectedMode,
			biomeIndex
		});
	}

	function sortZonesBy(column: TerraformsLevelZoneTableColumn): void {
		if (activeZoneSortColumn === column) {
			zoneSortDirection = toggleTerraformsLevelZoneSortDirection(zoneSortDirection);
			zoneSortColumn = column;
			return;
		}
		zoneSortColumn = column;
		zoneSortDirection = resolveTerraformsLevelZoneDefaultSortDirection(column);
	}

	function sortBiomesBy(column: TerraformsBiomeTableColumn): void {
		if (biomeSortColumn === column) {
			biomeSortDirection = toggleTerraformsBiomeSortDirection(biomeSortDirection);
			biomeSortColumn = column;
			return;
		}
		biomeSortColumn = column;
		biomeSortDirection = resolveTerraformsBiomeDefaultSortDirection(column);
	}

	function sortZonesByTableColumn(column: string): void {
		sortZonesBy(column as TerraformsLevelZoneTableColumn);
	}

	function formatZoneTableSortLabel(column: string): string {
		return formatTerraformsLevelZoneSortLabel(column as TerraformsLevelZoneTableColumn);
	}

	function resolveZoneTableAriaSort(
		column: string,
		activeColumn: string,
		direction: TerraformsLevelZoneSortDirection
	) {
		return resolveTerraformsLevelZoneAriaSort(
			column as TerraformsLevelZoneTableColumn,
			activeColumn as TerraformsLevelZoneTableColumn,
			direction
		);
	}

	function sortBiomesByTableColumn(column: string): void {
		sortBiomesBy(column as TerraformsBiomeTableColumn);
	}

	function formatBiomeTableSortLabel(column: string): string {
		return formatTerraformsBiomeSortLabel(column as TerraformsBiomeTableColumn);
	}

	function resolveBiomeTableAriaSort(
		column: string,
		activeColumn: string,
		direction: TerraformsBiomeSortDirection
	) {
		return resolveTerraformsBiomeAriaSort(
			column as TerraformsBiomeTableColumn,
			activeColumn as TerraformsBiomeTableColumn,
			direction
		);
	}

	function biomeCharacterSetClass(): string {
		const classNames: string[] = [TERRAFORMS_BIOME_TABLE_DOM.classes.characterSet];
		if (biomePreviewPalette !== null) {
			classNames.push(TERRAFORMS_BIOME_TABLE_DOM.classes.characterSetWithPalette);
		}
		return classNames.join(' ');
	}

	function resolveActiveZoneSortColumn(
		columns: readonly TerraformsLevelZoneTableColumn[],
		column: TerraformsLevelZoneTableColumn
	): TerraformsLevelZoneTableColumn {
		return columns.includes(column) ? column : defaultTerraformsLevelZoneSortColumn();
	}

	function resolveDetailTitle(
		currentSelection: TerraformsHypercastleSelection,
		levelNumber: number | null
	): string | null {
		if (isTerraformsAllLevelsSelection(currentSelection)) {
			return TERRAFORMS_HYPERCASTLE_SELECTION_LABELS.AllLevels;
		}
		return levelNumber === null ? null : formatTerraformsLevelTitle(levelNumber);
	}
</script>

<section class={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.root}>
	<div class={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.overview}>
		<TerraformsHypercastleOverview
			{selectedLevelNumber}
			{allLevelsSelected}
			{levelSurfaces}
			onLevelSelect={selectLevel}
			onAllLevelsSelect={selectAllLevels}
		/>
	</div>

	<aside
		class={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.detailPanel}
		data-testid={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.testIds.detailPanel}
	>
		{#if showZoneTable && detailTitle}
			{#if showDetailTitle}
				<h2 class={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.detailHeading}>
					{detailTitle}
				</h2>
			{/if}
			<h3 class={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.detailSubheading}>
				{TERRAFORMS_LEVEL_ZONE_SECTION_LABELS.Zones}
			</h3>
			<TerraformsTraitTable
				columns={zoneTableColumns}
				labels={TERRAFORMS_LEVEL_ZONE_TABLE_LABELS}
				activeColumn={activeZoneSortColumn}
				sortDirection={zoneSortDirection}
				className={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.table}
				testId={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.testIds.zoneTable}
				formatSortLabel={formatZoneTableSortLabel}
				resolveAriaSort={resolveZoneTableAriaSort}
				onSort={sortZonesByTableColumn}
			>
				{#each zoneRows as row (row.key)}
					{@const currentCopyState = paletteCopyState(row.key)}
					<tr>
						{#each zoneTableColumns as column}
							{#if column === TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name}
								<td>
									<a
										class={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.tableLink}
										href={zoneTokenHref(row)}
										title={formatTerraformsZoneTokenFilterLabel(row.name)}
										aria-label={formatTerraformsZoneTokenFilterLabel(row.name)}
									>
										{row.name}
									</a>
								</td>
							{:else if column === TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Palette}
								<td>
									<div class={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.paletteCell}>
										<div class={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.palette}>
											{#each row.palette as color, colorIndex}
												{@const swatchLabel = formatTerraformsZonePaletteSwatchLabel({
													zoneName: row.name,
													color,
													position: colorIndex + 1
												})}
												{#if selectedLevelNumber !== null}
													<button
														type={TERRAFORMS_LEVEL_ZONE_BUTTON_TYPES.Button}
														class={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.paletteSwatch}
														data-testid={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.testIds.paletteSwatch}
														style:background-color={color}
														title={swatchLabel}
														aria-label={swatchLabel}
														onclick={() => applyZonePalette(row)}
													></button>
												{:else}
													<span
														class={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.paletteSwatch}
														data-testid={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.testIds.paletteSwatch}
														style:background-color={color}
														title={swatchLabel}
													></span>
												{/if}
											{/each}
										</div>
										<button
											type={TERRAFORMS_LEVEL_ZONE_BUTTON_TYPES.Button}
											class={paletteCopyButtonClass(row.key)}
											data-testid={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.testIds.paletteCopyButton}
											title={formatTerraformsZonePaletteCopyLabel(currentCopyState)}
											aria-label={formatTerraformsZonePaletteCopyLabel(currentCopyState)}
											onclick={() => copyZonePalette(row)}
										>
											{#if currentCopyState === TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_STATES.Copied}
												<CheckIcon />
											{:else}
												<CopyIcon />
											{/if}
										</button>
									</div>
								</td>
							{:else if column === TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Minted}
								<td class={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.numericCell}>
									{formatTerraformsZoneMintedTokenCount(row)}
								</td>
							{/if}
						{/each}
					</tr>
				{/each}
			</TerraformsTraitTable>
		{/if}
	</aside>

	{#if showBiomeTable}
		<aside
			class={TERRAFORMS_BIOME_TABLE_DOM.classes.panel}
			data-testid={TERRAFORMS_BIOME_TABLE_DOM.testIds.panel}
		>
			<h3 class={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.detailSubheading}>
				{TERRAFORMS_BIOME_TABLE_LABELS.Heading}
			</h3>
			{#if selectedLevelNumber !== null && biomePreviewPalette !== null}
				<div class={TERRAFORMS_BIOME_TABLE_DOM.classes.controls}>
					<button
						type={TERRAFORMS_LEVEL_ZONE_BUTTON_TYPES.Button}
						class={TERRAFORMS_BIOME_TABLE_DOM.classes.colorResetButton}
						data-testid={TERRAFORMS_BIOME_TABLE_DOM.testIds.colorResetButton}
						onclick={resetBiomePreviewColors}
					>
						{TERRAFORMS_BIOME_TABLE_LABELS.ResetColors}
					</button>
				</div>
			{/if}
			<TerraformsTraitTable
				columns={TERRAFORMS_BIOME_TABLE_COLUMNS_ORDER}
				labels={TERRAFORMS_BIOME_TABLE_LABELS}
				activeColumn={biomeSortColumn}
				sortDirection={biomeSortDirection}
				className={`${TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.table} ${TERRAFORMS_BIOME_TABLE_DOM.classes.table}`}
				testId={TERRAFORMS_BIOME_TABLE_DOM.testIds.table}
				formatSortLabel={formatBiomeTableSortLabel}
				resolveAriaSort={resolveBiomeTableAriaSort}
				onSort={sortBiomesByTableColumn}
			>
				{#each biomeRows as row (row.key)}
					<tr>
						{#each TERRAFORMS_BIOME_TABLE_COLUMNS_ORDER as column}
							{#if column === TERRAFORMS_BIOME_TABLE_COLUMNS.Number}
								<td class={TERRAFORMS_BIOME_TABLE_DOM.classes.numberCell}>
									<a
										class={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.tableLink}
										href={biomeTokenHref(row.biomeIndex)}
										title={formatTerraformsBiomeTokenLabel(row.biomeIndex)}
										aria-label={formatTerraformsBiomeTokenLabel(row.biomeIndex)}
									>
										{row.biomeIndex}
									</a>
								</td>
							{:else if column === TERRAFORMS_BIOME_TABLE_COLUMNS.CharacterSet}
								<td>
									<div
										class={biomeCharacterSetClass()}
										style:background-color={biomePreviewBackgroundColor}
									>
										{#each row.displayCharacters as character, characterIndex}
											<span
												class={TERRAFORMS_BIOME_TABLE_DOM.classes.character}
												data-testid={TERRAFORMS_BIOME_TABLE_DOM.testIds.character}
												style:color={resolveTerraformsBiomePreviewCharacterColor(
													biomePreviewPalette,
													characterIndex
												)}
												title={formatTerraformsBiomeCharacterLabel({
													biomeIndex: row.biomeIndex,
													position: characterIndex + 1,
													character
												})}
											>
												{character}
											</span>
										{/each}
									</div>
								</td>
							{:else if column === TERRAFORMS_BIOME_TABLE_COLUMNS.Minted}
								<td class={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.numericCell}>
									{formatTerraformsBiomeMintedTokenCount(row)}
								</td>
							{/if}
						{/each}
					</tr>
				{/each}
			</TerraformsTraitTable>
		</aside>
	{/if}
</section>

<style>
	.terraforms-hypercastle-page {
		--terraforms-hypercastle-biome-character-size: 36px;
		--terraforms-hypercastle-biome-character-font-size: 36px;
		--terraforms-hypercastle-zone-palette-swatch-size: 32px;
		display: grid;
		grid-template-columns: minmax(420px, max-content) minmax(360px, max-content) minmax(
				260px,
				max-content
			);
		align-items: start;
		justify-content: start;
		column-gap: 1rem;
		max-width: 100%;
	}

	.terraforms-hypercastle-page-overview {
		justify-self: start;
		min-width: 0;
	}

	.terraforms-hypercastle-level-detail {
		width: min(100%, 640px);
		min-width: 0;
		padding-top: 14px;
	}

	.terraforms-hypercastle-biome-detail {
		width: min(100%, 560px);
		min-width: 0;
		padding-top: 14px;
	}

	.terraforms-hypercastle-level-detail-heading {
		margin: 0 0 0.4rem;
		font-size: 1rem;
		font-weight: 600;
		color: var(--c-ice);
		letter-spacing: 0;
	}

	.terraforms-hypercastle-biome-detail-controls {
		display: flex;
		flex-wrap: wrap;
		gap: var(--control-button-gap);
		margin: 0 0 0.75rem;
	}

	.terraforms-hypercastle-level-detail-subheading {
		margin: 1rem 0 0.35rem;
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--c-pink);
		text-transform: uppercase;
		letter-spacing: 0;
	}

	.terraforms-hypercastle-level-detail-heading + .terraforms-hypercastle-level-detail-subheading {
		margin-top: 0;
	}

	.terraforms-hypercastle-level-detail > .terraforms-hypercastle-level-detail-subheading:first-child,
	.terraforms-hypercastle-biome-detail > .terraforms-hypercastle-level-detail-subheading:first-child {
		margin-top: 0;
	}

	.terraforms-hypercastle-level-detail-placeholder {
		padding: 0.5rem 0;
		font-size: 0.82rem;
	}

	:global(.terraforms-hypercastle-zone-table) {
		width: auto;
		min-width: 39rem;
		table-layout: auto;
	}

	:global(.terraforms-hypercastle-zone-table th),
	:global(.terraforms-hypercastle-zone-table td) {
		vertical-align: middle;
	}

	:global(.terraforms-hypercastle-zone-table th:first-child),
	:global(.terraforms-hypercastle-zone-table td:first-child) {
		min-width: 7rem;
	}

	.terraforms-hypercastle-table-link {
		color: var(--c-cyan);
		font: inherit;
		text-decoration: underline;
		text-decoration-thickness: 1px;
		text-underline-offset: 2px;
	}

	.terraforms-hypercastle-table-link:hover,
	.terraforms-hypercastle-table-link:focus-visible {
		color: var(--c-yellow);
	}

	.terraforms-hypercastle-zone-palette-cell {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}

	.terraforms-hypercastle-zone-palette {
		display: grid;
		grid-template-columns: repeat(10, var(--terraforms-hypercastle-zone-palette-swatch-size));
		grid-auto-rows: var(--terraforms-hypercastle-zone-palette-swatch-size);
		width: fit-content;
		background: var(--c-bg);
	}

	.terraforms-hypercastle-zone-palette-swatch {
		display: block;
		width: var(--terraforms-hypercastle-zone-palette-swatch-size);
		height: var(--terraforms-hypercastle-zone-palette-swatch-size);
		min-height: 0;
		border: 0;
		border-radius: 0;
		padding: 0;
		appearance: none;
	}

	button.terraforms-hypercastle-zone-palette-swatch {
		cursor: pointer;
	}

	button.terraforms-hypercastle-zone-palette-swatch:hover,
	button.terraforms-hypercastle-zone-palette-swatch:focus-visible {
		position: relative;
		z-index: 1;
		outline: 1px solid var(--c-ice);
		outline-offset: -1px;
	}

	.terraforms-hypercastle-zone-palette-copy-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--c-cyan);
		cursor: pointer;
	}

	.terraforms-hypercastle-zone-palette-copy-button:hover,
	.terraforms-hypercastle-zone-palette-copy-button:focus-visible {
		color: var(--c-yellow);
	}

	.terraforms-hypercastle-zone-palette-copy-button-copied {
		color: var(--c-cyan);
	}

	.terraforms-hypercastle-zone-palette-copy-button-failed {
		color: var(--c-pink);
	}

	.terraforms-hypercastle-zone-numeric-cell {
		font-family: var(--font-mono);
		white-space: nowrap;
	}

	.terraforms-hypercastle-zone-numeric-cell {
		text-align: center;
	}

	:global(.terraforms-hypercastle-biome-table th:first-child),
	:global(.terraforms-hypercastle-biome-table td:first-child) {
		min-width: 3rem;
	}

	:global(.terraforms-hypercastle-biome-table) {
		min-width: 31rem;
	}

	:global(.terraforms-hypercastle-biome-table th),
	:global(.terraforms-hypercastle-biome-table td) {
		padding-left: 0.35rem;
		padding-right: 0.35rem;
	}

	.terraforms-hypercastle-biome-number-cell {
		font-family: var(--font-mono);
	}

	.terraforms-hypercastle-biome-character-set {
		display: grid;
		grid-template-columns: repeat(9, var(--terraforms-hypercastle-biome-character-size));
		grid-auto-rows: var(--terraforms-hypercastle-biome-character-size);
		align-items: center;
		width: fit-content;
	}

	.terraforms-hypercastle-biome-character-set-with-palette {
		padding: 3px;
	}

	.terraforms-hypercastle-biome-character {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: var(--terraforms-hypercastle-biome-character-size);
		height: var(--terraforms-hypercastle-biome-character-size);
		color: var(--c-ice);
		font-family: var(--font-mathcastles-remix);
		font-size: var(--terraforms-hypercastle-biome-character-font-size);
		line-height: 1;
	}

	@media (max-width: 980px) {
		.terraforms-hypercastle-page {
			--terraforms-hypercastle-biome-character-size: 30px;
			--terraforms-hypercastle-biome-character-font-size: 30px;
			--terraforms-hypercastle-zone-palette-swatch-size: 27px;
			grid-template-columns: minmax(0, 1fr);
			row-gap: 1rem;
		}

		.terraforms-hypercastle-level-detail {
			width: 100%;
			padding-top: 0;
		}

		.terraforms-hypercastle-biome-detail {
			width: 100%;
			padding-top: 0;
		}

		:global(.terraforms-hypercastle-zone-table) {
			min-width: 100%;
		}

		:global(.terraforms-hypercastle-biome-table) {
			min-width: 100%;
		}

		:global(.terraforms-hypercastle-zone-table th),
		:global(.terraforms-hypercastle-zone-table td) {
			padding: 0.42rem 0.35rem;
			font-size: 0.72rem;
		}

		:global(.terraforms-hypercastle-zone-table th:first-child),
		:global(.terraforms-hypercastle-zone-table td:first-child) {
			min-width: 5rem;
		}

		.terraforms-hypercastle-biome-character-set-with-palette {
			padding: 2px;
		}
	}
</style>
