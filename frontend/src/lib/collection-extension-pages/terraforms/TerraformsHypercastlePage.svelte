<script lang="ts">
	import type { CollectionExtensionPageProps } from '$lib/collection-extension-pages/types';
	import TerraformsHypercastleOverview from '$lib/collection-extension-pages/terraforms/TerraformsHypercastleOverview.svelte';
	import TerraformsSurfaceRerollIcon from '$lib/collection-extension-pages/terraforms/TerraformsSurfaceRerollIcon.svelte';
	import {
		buildTerraformsAllLevelZoneRows,
		buildTerraformsLevelZoneRows,
		defaultTerraformsLevelZoneSortColumn,
		defaultTerraformsLevelZoneSortDirection,
		defaultTerraformsSelectedLevelZoneSortColumn,
		defaultTerraformsSelectedLevelZoneSortDirection,
		formatTerraformsLevelZoneSortLabel,
		formatTerraformsZonePaletteSwatchLabel,
		formatTerraformsZoneTopographyHeights,
		formatTerraformsZoneTopographyRangeLabel,
		resolveTerraformsHypercastleLevel,
		resolveTerraformsLevelZoneAriaSort,
		resolveTerraformsLevelZoneDefaultSortDirection,
		sortTerraformsLevelZoneRows,
		toggleTerraformsLevelZoneSortDirection,
		TERRAFORMS_LEVEL_ZONE_BUTTON_TYPES,
		TERRAFORMS_LEVEL_ZONE_TABLE_COLUMN_SETS,
		TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS,
		TERRAFORMS_LEVEL_ZONE_TABLE_DOM,
		TERRAFORMS_LEVEL_ZONE_TABLE_LABELS,
		type TerraformsLevelZoneSortDirection,
		type TerraformsLevelZoneTableColumn
	} from '$lib/collection-extension-pages/terraforms/level-zones';
	import {
		formatTerraformsLevelTitle,
		isTerraformsAllLevelsSelection,
		resolveTerraformsSelectedLevelNumber,
		TERRAFORMS_HYPERCASTLE_SELECTION_LABELS,
		TERRAFORMS_HYPERCASTLE_SELECTION_SCOPES,
		type TerraformsHypercastleSelection
	} from '$lib/collection-extension-pages/terraforms/hypercastle-selection';
	import {
		buildTerraformsHypercastleLevelSurfaces,
		replaceTerraformsHypercastleLevelSurface,
		TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_DOM,
		TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_LABELS
	} from '$lib/collection-extension-pages/terraforms/hypercastle-surface-texture';

	let {}: CollectionExtensionPageProps = $props();

	let selection = $state<TerraformsHypercastleSelection>(null);
	let zoneSortColumn = $state<TerraformsLevelZoneTableColumn>(
		defaultTerraformsLevelZoneSortColumn()
	);
	let zoneSortDirection = $state<TerraformsLevelZoneSortDirection>(
		defaultTerraformsLevelZoneSortDirection()
	);
	let levelSurfaces = $state(buildTerraformsHypercastleLevelSurfaces());
	let selectedLevelNumber = $derived(resolveTerraformsSelectedLevelNumber(selection));
	let allLevelsSelected = $derived(isTerraformsAllLevelsSelection(selection));
	let selectedLevel = $derived(resolveTerraformsHypercastleLevel(selectedLevelNumber));
	let showSurfaceTextureControls = $derived(allLevelsSelected);
	let zoneTableColumns: readonly TerraformsLevelZoneTableColumn[] = $derived(
		allLevelsSelected
			? TERRAFORMS_LEVEL_ZONE_TABLE_COLUMN_SETS.AllLevels
			: selectedLevel
				? TERRAFORMS_LEVEL_ZONE_TABLE_COLUMN_SETS.SelectedLevel
				: []
	);
	let showTopography = $derived(
		zoneTableColumns.includes(TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Topography)
	);
	let activeZoneSortColumn = $derived(resolveActiveZoneSortColumn(zoneTableColumns, zoneSortColumn));
	let zoneRows = $derived(
		allLevelsSelected
			? sortTerraformsLevelZoneRows(
					buildTerraformsAllLevelZoneRows(),
					activeZoneSortColumn,
					zoneSortDirection
				)
			: selectedLevel
			? sortTerraformsLevelZoneRows(
					buildTerraformsLevelZoneRows(selectedLevel),
					activeZoneSortColumn,
					zoneSortDirection
				)
			: []
	);
	let detailTitle = $derived(resolveDetailTitle(selection, selectedLevelNumber));
	let showZoneTable = $derived(detailTitle !== null && zoneRows.length > 0);

	function selectLevel(levelNumber: number): void {
		selection = levelNumber;
		zoneSortColumn = defaultTerraformsSelectedLevelZoneSortColumn();
		zoneSortDirection = defaultTerraformsSelectedLevelZoneSortDirection();
	}

	function selectAllLevels(): void {
		selection = TERRAFORMS_HYPERCASTLE_SELECTION_SCOPES.AllLevels;
		zoneSortColumn = defaultTerraformsLevelZoneSortColumn();
		zoneSortDirection = defaultTerraformsLevelZoneSortDirection();
	}

	function rerollAllLevelSurfaces(): void {
		levelSurfaces = buildTerraformsHypercastleLevelSurfaces();
	}

	function applyZoneSurface(zoneIndex: number): void {
		if (selectedLevelNumber === null) return;
		levelSurfaces = replaceTerraformsHypercastleLevelSurface({
			surfaces: levelSurfaces,
			levelNumber: selectedLevelNumber,
			zoneIndex
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
	{#if showSurfaceTextureControls}
		<div class={TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_DOM.classes.controls}>
			<button
				type={TERRAFORMS_LEVEL_ZONE_BUTTON_TYPES.Button}
				class={TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_DOM.classes.rerollButton}
				data-testid={TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_DOM.testIds.rerollButton}
				title={TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_LABELS.RerollSurfaces}
				aria-label={TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_LABELS.RerollSurfaces}
				onclick={rerollAllLevelSurfaces}
			>
				<TerraformsSurfaceRerollIcon />
			</button>
		</div>
	{/if}

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
			<h2 class={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.detailHeading}>
				{detailTitle}
			</h2>
			<div class="table-wrap">
				<table
					class={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.table}
					data-testid={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.testIds.zoneTable}
				>
					<thead>
						<tr>
							{#each zoneTableColumns as column}
								<th
									aria-sort={resolveTerraformsLevelZoneAriaSort(
										column,
										activeZoneSortColumn,
										zoneSortDirection
									)}
								>
									<button
										type={TERRAFORMS_LEVEL_ZONE_BUTTON_TYPES.Button}
										class={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.sortButton}
										aria-label={formatTerraformsLevelZoneSortLabel(column)}
										onclick={() => sortZonesBy(column)}
									>
										<span>{TERRAFORMS_LEVEL_ZONE_TABLE_LABELS[column]}</span>
									</button>
								</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each zoneRows as row (row.key)}
							<tr>
								<td>{row.name}</td>
								<td>
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
													onclick={() => applyZoneSurface(row.zoneIndex)}
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
								</td>
								{#if showTopography}
									<td
										class={TERRAFORMS_LEVEL_ZONE_TABLE_DOM.classes.numericCell}
										title={formatTerraformsZoneTopographyRangeLabel(row)}
									>
										{formatTerraformsZoneTopographyHeights(row)}
									</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</aside>
</section>

<style>
	.terraforms-hypercastle-page {
		display: grid;
		grid-template-columns: minmax(420px, max-content) minmax(360px, 560px);
		align-items: start;
		justify-content: start;
		column-gap: 2rem;
		max-width: 100%;
	}

	.terraforms-hypercastle-surface-controls {
		grid-column: 1 / -1;
		display: flex;
		justify-content: flex-start;
		margin: 0 0 0.55rem;
	}

	.terraforms-hypercastle-page-overview {
		justify-self: start;
		min-width: 0;
	}

	.terraforms-hypercastle-level-detail {
		width: min(100%, 560px);
		min-width: 0;
		padding-top: 14px;
	}

	.terraforms-hypercastle-level-detail-heading {
		margin: 0 0 0.75rem;
		font-size: 1rem;
		font-weight: 600;
		color: var(--c-ice);
		letter-spacing: 0;
	}

	.terraforms-hypercastle-level-detail-placeholder {
		padding: 0.5rem 0;
		font-size: 0.82rem;
	}

	.terraforms-hypercastle-surface-reroll {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		min-height: 0;
		border: 1px solid color-mix(in srgb, var(--c-blue) 58%, transparent);
		border-radius: 0;
		padding: 0;
		background: transparent;
		color: var(--c-ice);
		line-height: 1;
	}

	.terraforms-hypercastle-surface-reroll:hover,
	.terraforms-hypercastle-surface-reroll:focus-visible {
		border-color: var(--c-blue);
		color: var(--c-blue);
	}

	.terraforms-hypercastle-zone-table {
		width: auto;
		min-width: 34rem;
		table-layout: auto;
	}

	.terraforms-hypercastle-zone-table th,
	.terraforms-hypercastle-zone-table td {
		vertical-align: middle;
	}

	.terraforms-hypercastle-zone-table th:first-child,
	.terraforms-hypercastle-zone-table td:first-child {
		min-width: 7rem;
	}

	.terraforms-hypercastle-zone-table th:nth-child(2),
	.terraforms-hypercastle-zone-table td:nth-child(2) {
		min-width: 11rem;
	}

	.terraforms-hypercastle-zone-table th:nth-child(3),
	.terraforms-hypercastle-zone-table td:nth-child(3) {
		text-align: center;
	}

	.terraforms-hypercastle-zone-table th:nth-child(3) .terraforms-hypercastle-zone-sort-button {
		justify-content: center;
		width: 100%;
	}

	.terraforms-hypercastle-zone-sort-button {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		width: fit-content;
		min-height: 0;
		border: 0;
		padding: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		text-transform: inherit;
		letter-spacing: inherit;
	}

	.terraforms-hypercastle-zone-palette {
		display: grid;
		grid-template-columns: repeat(10, 16px);
		grid-auto-rows: 16px;
		width: fit-content;
		background: var(--c-bg);
	}

	.terraforms-hypercastle-zone-palette-swatch {
		display: block;
		width: 16px;
		height: 16px;
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

	.terraforms-hypercastle-zone-numeric-cell {
		font-family: var(--font-mono);
		white-space: nowrap;
		text-align: center;
	}

	@media (max-width: 980px) {
		.terraforms-hypercastle-page {
			grid-template-columns: minmax(0, 1fr);
			row-gap: 1rem;
		}

		.terraforms-hypercastle-level-detail {
			width: 100%;
			padding-top: 0;
		}

		.terraforms-hypercastle-zone-table {
			min-width: 100%;
		}

		.terraforms-hypercastle-zone-table th,
		.terraforms-hypercastle-zone-table td {
			padding: 0.42rem 0.35rem;
			font-size: 0.72rem;
		}

		.terraforms-hypercastle-zone-table th:first-child,
		.terraforms-hypercastle-zone-table td:first-child {
			min-width: 5rem;
		}

		.terraforms-hypercastle-zone-table th:nth-child(2),
		.terraforms-hypercastle-zone-table td:nth-child(2) {
			min-width: 8.4rem;
		}

		.terraforms-hypercastle-zone-palette {
			grid-template-columns: repeat(10, 13px);
			grid-auto-rows: 13px;
		}

		.terraforms-hypercastle-zone-palette-swatch {
			width: 13px;
			height: 13px;
		}
	}
</style>
