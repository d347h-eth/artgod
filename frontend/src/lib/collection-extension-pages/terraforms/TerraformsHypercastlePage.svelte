<script lang="ts">
	import { page as routePage } from '$app/state';
	import {
		TERRAFORMS_BIOMES,
		TERRAFORMS_HYPERCASTLE_LEVEL_COUNT,
		TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS,
		TERRAFORMS_HYPERCASTLE_LEVELS,
		TERRAFORMS_HYPERCASTLE_MAX_LEVEL_DIMENSION,
		TERRAFORMS_HYPERCASTLE_TOTAL_PARCELS,
		TERRAFORMS_RESOURCE_ATTRIBUTE_KEY,
		TERRAFORMS_ZONES,
		type TerraformsBiome,
		type TerraformsLevelGroupSummary,
		type TerraformsLevelSummary,
		type TerraformsZone
	} from '@artgod/shared/extensions/terraforms';
	import type { CollectionExtensionPageProps } from '$lib/collection-extension-pages/types';
	import {
		TERRAFORMS_HYPERCASTLE_ARIA_LABELS,
		TERRAFORMS_HYPERCASTLE_CATALOG_KEYS,
		TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES,
		TERRAFORMS_HYPERCASTLE_LABELS,
		TERRAFORMS_HYPERCASTLE_NUMBER_FORMAT_LOCALE,
		TERRAFORMS_HYPERCASTLE_SORT_DIRECTIONS,
		TERRAFORMS_HYPERCASTLE_SORT_KEYS
	} from '$lib/collection-extension-pages/terraforms/constants';
	import {
		TERRAFORMS_HYPERCASTLE_CATALOGS,
		buildTerraformsBiomeCatalogRows,
		buildTerraformsHypercastleHref,
		buildTerraformsLevelCatalogRows,
		buildTerraformsZoneCatalogRows,
		sortTerraformsBiomeCatalogRows,
		sortTerraformsLevelCatalogRows,
		sortTerraformsZoneCatalogRows,
		resolveTerraformsHypercastleState,
		type TerraformsHypercastleCatalog,
		type TerraformsHypercastleHrefUpdate,
		type TerraformsHypercastleSortKey
	} from '$lib/collection-extension-pages/terraforms/hypercastle-catalog';

	let { collection, page }: CollectionExtensionPageProps = $props();

	const levelCatalogRows = buildTerraformsLevelCatalogRows();
	const zoneCatalogRows = buildTerraformsZoneCatalogRows();
	const biomeCatalogRows = buildTerraformsBiomeCatalogRows();

	const explorerState = $derived(resolveTerraformsHypercastleState(routePage.url.searchParams));
	const sortedLevelRows = $derived(
		sortTerraformsLevelCatalogRows(
			levelCatalogRows,
			explorerState.sort,
			explorerState.direction
		)
	);
	const sortedZoneRows = $derived(
		sortTerraformsZoneCatalogRows(zoneCatalogRows, explorerState.sort, explorerState.direction)
	);
	const sortedBiomeRows = $derived(
		sortTerraformsBiomeCatalogRows(
			biomeCatalogRows,
			explorerState.sort,
			explorerState.direction
		)
	);

	function explorerHref(update: TerraformsHypercastleHrefUpdate): string {
		return buildTerraformsHypercastleHref(
			routePage.url.pathname,
			routePage.url.searchParams,
			update
		);
	}

	function catalogHref(catalog: TerraformsHypercastleCatalog): string {
		return explorerHref({ catalog });
	}

	function sortHref(sort: TerraformsHypercastleSortKey): string {
		return explorerHref({
			sort,
			direction:
				explorerState.sort === sort &&
				explorerState.direction === TERRAFORMS_HYPERCASTLE_SORT_DIRECTIONS.Asc
					? TERRAFORMS_HYPERCASTLE_SORT_DIRECTIONS.Desc
					: TERRAFORMS_HYPERCASTLE_SORT_DIRECTIONS.Asc
		});
	}

	function sortMarker(sort: TerraformsHypercastleSortKey): string {
		if (explorerState.sort !== sort) return '';
		return explorerState.direction === TERRAFORMS_HYPERCASTLE_SORT_DIRECTIONS.Asc ? '^' : 'v';
	}

	function groupHref(group: TerraformsLevelGroupSummary): string {
		return explorerHref({ groupId: group.groupId, levelNumber: null });
	}

	function levelHref(level: TerraformsLevelSummary): string {
		return explorerHref({ levelNumber: level.levelNumber });
	}

	function clearFocusHref(): string {
		return explorerHref({ groupId: null, levelNumber: null });
	}

	function levelStyle(level: TerraformsLevelSummary): string {
		return [
			`--level-scale: ${level.dimension / TERRAFORMS_HYPERCASTLE_MAX_LEVEL_DIMENSION}`,
			`--level-gradient: ${zoneGradient(level.zones)}`
		].join('; ');
	}

	function zoneStyle(zone: TerraformsZone): string {
		return `--zone-gradient: ${paletteGradient(zone.palette)}`;
	}

	function zoneGradient(zones: readonly TerraformsZone[]): string {
		if (zones.length === 1) return paletteGradient(zones[0].palette);
		return `linear-gradient(90deg, ${zones
			.map((zone, index) => {
				const start = (index / zones.length) * 100;
				const end = ((index + 1) / zones.length) * 100;
				return `${zone.palette[0]} ${start}% ${end}%`;
			})
			.join(', ')})`;
	}

	function paletteGradient(palette: readonly string[]): string {
		return `linear-gradient(90deg, ${palette
			.map((color, index) => {
				const start = (index / palette.length) * 100;
				const end = ((index + 1) / palette.length) * 100;
				return `${color} ${start}% ${end}%`;
			})
			.join(', ')})`;
	}

	function weightStyle(weightPercent: number): string {
		return `--weight-percent: ${weightPercent}`;
	}

	function formatInteger(value: number): string {
		return value.toLocaleString(TERRAFORMS_HYPERCASTLE_NUMBER_FORMAT_LOCALE);
	}

	function formatLevels(levelNumbers: readonly number[]): string {
		return levelNumbers
			.map((levelNumber) => `${TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.Level}${levelNumber}`)
			.join(' ');
	}

	function formatZoneNames(zones: readonly TerraformsZone[]): string {
		return zones.map((zone) => zone.name).join(', ');
	}

	function formatBiomeIndices(indices: readonly number[]): string {
		return indices
			.map((index) => `${TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.Biome}${index}`)
			.join(' ');
	}

	function formatThreshold(value: number | null): string {
		return value === null ? TERRAFORMS_HYPERCASTLE_LABELS.Base : `>${formatInteger(value)}`;
	}

	function catalogLabel(catalog: TerraformsHypercastleCatalog): string {
		switch (catalog) {
			case TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Zones:
				return TERRAFORMS_HYPERCASTLE_LABELS.Zones;
			case TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Biomes:
				return TERRAFORMS_HYPERCASTLE_LABELS.Biomes;
			case TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Levels:
			default:
				return TERRAFORMS_HYPERCASTLE_LABELS.Levels;
		}
	}

	function biomeGlyphStyle(biome: TerraformsBiome): string {
		return `font-size: ${Math.max(12, Math.round(biome.fontSize * 0.72))}px`;
	}
</script>

<section class="terraforms-hypercastle-page" data-extension-key={page.extensionKey}>
	<header class="hypercastle-header">
		<div class="hypercastle-title">
			<h1>Hypercastle</h1>
			<span>{collection.slug}</span>
		</div>
		<div class="hypercastle-stats" aria-label={TERRAFORMS_HYPERCASTLE_ARIA_LABELS.ContractTotals}>
			<div>
				<strong>{TERRAFORMS_HYPERCASTLE_LEVEL_COUNT}</strong>
				<span>{TERRAFORMS_HYPERCASTLE_LABELS.Levels}</span>
			</div>
			<div>
				<strong>{TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS.length}</strong>
				<span>{TERRAFORMS_HYPERCASTLE_LABELS.ZoneSets}</span>
			</div>
			<div>
				<strong>{TERRAFORMS_ZONES.length}</strong>
				<span>{TERRAFORMS_HYPERCASTLE_LABELS.Zones}</span>
			</div>
			<div>
				<strong>{TERRAFORMS_BIOMES.length}</strong>
				<span>{TERRAFORMS_HYPERCASTLE_LABELS.Biomes}</span>
			</div>
			<div>
				<strong>{formatInteger(TERRAFORMS_HYPERCASTLE_TOTAL_PARCELS)}</strong>
				<span>{TERRAFORMS_HYPERCASTLE_LABELS.Parcels}</span>
			</div>
		</div>
	</header>

	<section class="hypercastle-workbench" aria-label={TERRAFORMS_HYPERCASTLE_ARIA_LABELS.Structure}>
		<section class="hypercastle-stack" aria-label={TERRAFORMS_HYPERCASTLE_ARIA_LABELS.Levels}>
			<header class="section-heading">
				<h2>{TERRAFORMS_HYPERCASTLE_LABELS.Levels}</h2>
				<a href={clearFocusHref()}>{TERRAFORMS_HYPERCASTLE_LABELS.All}</a>
			</header>
			<div class="level-stack">
				{#each TERRAFORMS_HYPERCASTLE_LEVELS as level (level.levelNumber)}
					<a
						class="level-link"
						class:level-link-active={explorerState.selectedLevel?.levelNumber === level.levelNumber}
						class:level-link-in-group={explorerState.selectedGroup?.levelNumbers.includes(
							level.levelNumber
						) && explorerState.selectedLevel?.levelNumber !== level.levelNumber}
						href={levelHref(level)}
						style={levelStyle(level)}
					>
						<span class="level-label">{TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.Level}{level.levelNumber}</span>
						<span class="level-shape">
							<span>{formatInteger(level.parcelCount)}</span>
						</span>
						<span class="level-meta">{level.dimension}x{level.dimension}</span>
					</a>
				{/each}
			</div>
		</section>

		<section class="hypercastle-focus" aria-label={TERRAFORMS_HYPERCASTLE_ARIA_LABELS.Focus}>
			{#if explorerState.selectedLevel}
				<header class="section-heading">
					<h2>{TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.Level}{explorerState.selectedLevel.levelNumber}</h2>
					<a href={groupHref(explorerState.selectedGroup!)}>{explorerState.selectedGroup?.groupId}</a>
				</header>
				<div class="focus-stat-grid">
					<div>
						<strong>{explorerState.selectedLevel.dimension}x{explorerState.selectedLevel.dimension}</strong>
						<span>{TERRAFORMS_HYPERCASTLE_LABELS.Grid}</span>
					</div>
					<div>
						<strong>{formatInteger(explorerState.selectedLevel.parcelCount)}</strong>
						<span>{TERRAFORMS_HYPERCASTLE_LABELS.Parcels}</span>
					</div>
					<div>
						<strong>{explorerState.selectedLevel.zones.length}</strong>
						<span>{TERRAFORMS_HYPERCASTLE_LABELS.Zones}</span>
					</div>
					<div>
						<strong>{explorerState.selectedLevel.availableBiomeGroupWeights.length}</strong>
						<span>{TERRAFORMS_HYPERCASTLE_LABELS.BiomeGroups}</span>
					</div>
				</div>
				<div class="focus-columns">
					<div class="focus-block">
						<h3>{TERRAFORMS_HYPERCASTLE_LABELS.Zones}</h3>
						<div class="zone-chip-list">
							{#each explorerState.selectedLevel.zones as zone (zone.index)}
								<a
									href={catalogHref(TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Zones)}
									class="zone-chip"
									style={zoneStyle(zone)}
								>
									<span>{zone.name}</span>
								</a>
							{/each}
						</div>
					</div>
					<div class="focus-block">
						<h3>{TERRAFORMS_HYPERCASTLE_LABELS.BiomeWeights}</h3>
						<div class="weight-list">
							{#each explorerState.selectedLevel.availableBiomeGroupWeights as weight (weight.groupIndex)}
								<a
									href={catalogHref(TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Biomes)}
									class="weight-row"
									style={weightStyle(weight.weightPercent)}
								>
									<span>{TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.BiomeGroup}{weight.groupIndex}</span>
									<span class="weight-meter"><span></span></span>
									<span>{weight.weightPercent}%</span>
									<span>{formatBiomeIndices(weight.biomeIndices)}</span>
								</a>
							{/each}
						</div>
					</div>
				</div>
				<div class="table-wrap compact-table-wrap">
					<table>
						<thead>
							<tr>
								<th>{TERRAFORMS_HYPERCASTLE_LABELS.Elevation}</th>
								<th>{TERRAFORMS_HYPERCASTLE_LABELS.Threshold}</th>
								<th>{TERRAFORMS_HYPERCASTLE_LABELS.Zone}</th>
							</tr>
						</thead>
						<tbody>
							{#each explorerState.selectedLevel.topographyZoneBuckets as bucket}
								<tr>
									<td>{bucket.elevation}</td>
									<td>{formatThreshold(bucket.thresholdGreaterThan)}</td>
									<td>{bucket.zoneName}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else if explorerState.selectedGroup}
				<header class="section-heading">
					<h2>{explorerState.selectedGroup.groupId}</h2>
					<a href={clearFocusHref()}>{TERRAFORMS_HYPERCASTLE_LABELS.All}</a>
				</header>
				<div class="focus-stat-grid">
					<div>
						<strong>{formatLevels(explorerState.selectedGroup.levelNumbers)}</strong>
						<span>{TERRAFORMS_HYPERCASTLE_LABELS.Levels}</span>
					</div>
					<div>
						<strong>{explorerState.selectedGroup.zoneNames.length}</strong>
						<span>{TERRAFORMS_HYPERCASTLE_LABELS.Zones}</span>
					</div>
					<div>
						<strong>{formatInteger(explorerState.selectedGroup.totalParcels)}</strong>
						<span>{TERRAFORMS_HYPERCASTLE_LABELS.Parcels}</span>
					</div>
					<div>
						<strong>{explorerState.selectedGroup.maxDimension}x{explorerState.selectedGroup.maxDimension}</strong>
						<span>{TERRAFORMS_HYPERCASTLE_LABELS.MaxGrid}</span>
					</div>
				</div>
				<div class="zone-chip-list">
					{#each explorerState.selectedGroup.zoneIndices as zoneIndex}
						{@const zone = TERRAFORMS_ZONES[zoneIndex]}
						<a
							href={catalogHref(TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Zones)}
							class="zone-chip"
							style={zoneStyle(zone)}
						>
							<span>{zone.name}</span>
						</a>
					{/each}
				</div>
				<div class="group-level-links">
					{#each explorerState.selectedGroup.levelNumbers as levelNumber}
						{@const level = TERRAFORMS_HYPERCASTLE_LEVELS[levelNumber - 1]}
						<a href={levelHref(level)}>{TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.Level}{levelNumber}</a>
					{/each}
				</div>
			{:else}
				<header class="section-heading">
					<h2>{TERRAFORMS_HYPERCASTLE_LABELS.Overview}</h2>
					<a href={catalogHref(TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Levels)}>
						{TERRAFORMS_HYPERCASTLE_LABELS.Catalog}
					</a>
				</header>
				<div class="focus-stat-grid">
					<div>
						<strong>{TERRAFORMS_HYPERCASTLE_LABELS.OverviewWidestLevels}</strong>
						<span>{TERRAFORMS_HYPERCASTLE_LABELS.Widest}</span>
					</div>
					<div>
						<strong>{TERRAFORMS_HYPERCASTLE_LABELS.OverviewMaxGrid}</strong>
						<span>{TERRAFORMS_HYPERCASTLE_LABELS.MaxGrid}</span>
					</div>
					<div>
						<strong>{formatInteger(TERRAFORMS_HYPERCASTLE_TOTAL_PARCELS)}</strong>
						<span>{TERRAFORMS_HYPERCASTLE_LABELS.Parcels}</span>
					</div>
					<div>
						<strong>{TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS.length}</strong>
						<span>{TERRAFORMS_HYPERCASTLE_LABELS.ZoneSets}</span>
					</div>
				</div>
				<div class="zone-chip-list">
					{#each TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS.slice(0, 6) as group}
						<a href={groupHref(group)} class="zone-set-chip">{formatLevels(group.levelNumbers)}</a>
					{/each}
				</div>
			{/if}
		</section>
	</section>

	<section class="level-groups" aria-label={TERRAFORMS_HYPERCASTLE_ARIA_LABELS.LevelGroups}>
		<header class="section-heading">
			<h2>{TERRAFORMS_HYPERCASTLE_LABELS.ZoneSets}</h2>
			<span>{TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS.length}</span>
		</header>
		<div class="level-group-grid">
			{#each TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS as group}
				<a
					href={groupHref(group)}
					class="level-group"
					class:level-group-active={explorerState.selectedGroup?.groupId === group.groupId &&
						!explorerState.selectedLevel}
				>
					<span class="level-group-levels">{formatLevels(group.levelNumbers)}</span>
					<span class="level-group-zones">{group.zoneNames.join(', ')}</span>
					<span class="level-group-meta">
						{group.maxDimension}x{group.maxDimension} / {formatInteger(group.totalParcels)} parcels
					</span>
				</a>
			{/each}
		</div>
	</section>

	<section class="catalog-section" aria-label={TERRAFORMS_HYPERCASTLE_ARIA_LABELS.Catalog}>
		<header class="catalog-header">
			<div class="section-heading">
				<h2>{TERRAFORMS_HYPERCASTLE_LABELS.Catalog}</h2>
				<span>{catalogLabel(explorerState.catalog)}</span>
			</div>
			<nav class="secondary-tabs" aria-label={TERRAFORMS_HYPERCASTLE_ARIA_LABELS.CatalogTabs}>
				{#each TERRAFORMS_HYPERCASTLE_CATALOGS as catalog}
					{#if explorerState.catalog === catalog}
						<span class="secondary-tab-active">{catalogLabel(catalog)}</span>
					{:else}
						<a href={catalogHref(catalog)}>{catalogLabel(catalog)}</a>
					{/if}
				{/each}
			</nav>
		</header>

		{#if explorerState.catalog === TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Levels}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th><a href={sortHref(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Level)}>{TERRAFORMS_HYPERCASTLE_LABELS.Level} {sortMarker(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Level)}</a></th>
							<th><a href={sortHref(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Parcels)}>{TERRAFORMS_HYPERCASTLE_LABELS.Parcels} {sortMarker(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Parcels)}</a></th>
							<th><a href={sortHref(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Dimension)}>{TERRAFORMS_HYPERCASTLE_LABELS.Grid} {sortMarker(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Dimension)}</a></th>
							<th><a href={sortHref(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Zones)}>{TERRAFORMS_HYPERCASTLE_LABELS.Zones} {sortMarker(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Zones)}</a></th>
							<th><a href={sortHref(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Biomes)}>{TERRAFORMS_HYPERCASTLE_LABELS.Biomes} {sortMarker(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Biomes)}</a></th>
							<th>{TERRAFORMS_HYPERCASTLE_LABELS.ZoneSet}</th>
						</tr>
					</thead>
					<tbody>
						{#each sortedLevelRows as row}
							<tr>
								<td><a href={levelHref(row.level)}>{TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.Level}{row.level.levelNumber}</a></td>
								<td>{formatInteger(row.level.parcelCount)}</td>
								<td>{row.level.dimension}x{row.level.dimension}</td>
								<td>{formatZoneNames(row.level.zones)}</td>
								<td>{row.availableBiomeCount}</td>
								<td><a href={groupHref(row.group)}>{row.group.groupId}</a></td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else if explorerState.catalog === TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Zones}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th><a href={sortHref(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Index)}>{TERRAFORMS_HYPERCASTLE_LABELS.Zone} {sortMarker(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Index)}</a></th>
							<th><a href={sortHref(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Name)}>{TERRAFORMS_HYPERCASTLE_LABELS.Name} {sortMarker(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Name)}</a></th>
							<th>{TERRAFORMS_HYPERCASTLE_LABELS.Palette}</th>
							<th><a href={sortHref(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Levels)}>{TERRAFORMS_HYPERCASTLE_LABELS.Levels} {sortMarker(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Levels)}</a></th>
							<th><a href={sortHref(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Parcels)}>{TERRAFORMS_HYPERCASTLE_LABELS.LevelParcels} {sortMarker(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Parcels)}</a></th>
							<th><a href={sortHref(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Buckets)}>{TERRAFORMS_HYPERCASTLE_LABELS.Buckets} {sortMarker(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Buckets)}</a></th>
						</tr>
					</thead>
					<tbody>
						{#each sortedZoneRows as row}
							<tr>
								<td>{TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.Zone}{row.zone.index}</td>
								<td>{row.zone.name}</td>
								<td>
									<span class="palette-strip" style={zoneStyle(row.zone)}></span>
								</td>
								<td>{formatLevels(row.levelNumbers)}</td>
								<td>{formatInteger(row.levelParcels)}</td>
								<td>{row.topographyBuckets}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th><a href={sortHref(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Index)}>{TERRAFORMS_HYPERCASTLE_LABELS.Biome} {sortMarker(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Index)}</a></th>
							<th><a href={sortHref(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Group)}>{TERRAFORMS_HYPERCASTLE_LABELS.Group} {sortMarker(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Group)}</a></th>
							<th>{TERRAFORMS_HYPERCASTLE_LABELS.Characters}</th>
							<th><a href={sortHref(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Levels)}>{TERRAFORMS_HYPERCASTLE_LABELS.Levels} {sortMarker(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Levels)}</a></th>
							<th><a href={sortHref(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Parcels)}>{TERRAFORMS_HYPERCASTLE_LABELS.LevelParcels} {sortMarker(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Parcels)}</a></th>
							<th><a href={sortHref(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Weight)}>{TERRAFORMS_HYPERCASTLE_LABELS.MaxWeight} {sortMarker(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Weight)}</a></th>
							<th><a href={sortHref(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Resource)}>{TERRAFORMS_RESOURCE_ATTRIBUTE_KEY} {sortMarker(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Resource)}</a></th>
						</tr>
					</thead>
					<tbody>
						{#each sortedBiomeRows as row}
							<tr>
								<td>{TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.Biome}{row.biome.index}</td>
								<td>{TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.BiomeGroup}{row.biome.groupIndex}</td>
								<td>
									<span class="biome-glyphs" style={biomeGlyphStyle(row.biome)}>
										{row.biome.characters.join('')}
									</span>
								</td>
								<td>{formatLevels(row.levelNumbers)}</td>
								<td>{formatInteger(row.levelParcels)}</td>
								<td>{row.maxWeightPercent}%</td>
								<td>{row.resourceCount}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</section>

<style>
	.terraforms-hypercastle-page {
		display: grid;
		gap: 18px;
		padding: 18px 0 4px;
	}

	.hypercastle-header,
	.catalog-header {
		display: flex;
		flex-wrap: wrap;
		gap: 18px;
		align-items: end;
		justify-content: flex-start;
	}

	.hypercastle-title,
	.section-heading {
		display: grid;
		gap: 2px;
	}

	.hypercastle-title h1,
	.section-heading h2,
	.focus-block h3 {
		margin: 0;
		font-weight: 650;
		line-height: 1.1;
		text-transform: uppercase;
	}

	.hypercastle-title h1 {
		font-size: 1.45rem;
	}

	.section-heading h2 {
		font-size: 0.95rem;
		color: var(--c-pink);
	}

	.focus-block h3 {
		font-size: 0.75rem;
		color: var(--c-pink);
	}

	.hypercastle-title span,
	.section-heading span,
	.section-heading a,
	.level-group-meta,
	.level-meta {
		color: var(--c-sand);
		font-size: 0.8rem;
	}

	.hypercastle-stats,
	.focus-stat-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.hypercastle-stats div,
	.focus-stat-grid div {
		display: grid;
		min-width: 78px;
		gap: 2px;
		border: 1px solid var(--c-blue);
		border-radius: 6px;
		padding: 8px 10px;
	}

	.focus-stat-grid div {
		min-width: 92px;
	}

	.hypercastle-stats strong,
	.focus-stat-grid strong {
		font-size: 1rem;
		font-weight: 650;
	}

	.focus-stat-grid strong {
		word-break: break-word;
	}

	.hypercastle-stats span,
	.focus-stat-grid span {
		color: var(--c-sand);
		font-size: 0.76rem;
	}

	.hypercastle-workbench {
		display: grid;
		grid-template-columns: minmax(280px, 0.92fr) minmax(320px, 1.08fr);
		gap: 14px;
		align-items: start;
	}

	.hypercastle-stack,
	.hypercastle-focus,
	.level-groups,
	.catalog-section {
		display: grid;
		gap: 10px;
		min-width: 0;
	}

	.level-stack {
		display: grid;
		gap: 5px;
	}

	.level-link {
		display: grid;
		grid-template-columns: 2.7rem minmax(0, 1fr) 4.6rem;
		align-items: center;
		gap: 8px;
		min-height: 28px;
		color: var(--c-ice);
	}

	.level-link:hover,
	.level-link:focus-visible {
		color: var(--c-yellow);
	}

	.level-link-active {
		color: var(--c-orange);
	}

	.level-link-in-group {
		color: var(--c-cyan);
	}

	.level-label,
	.level-meta {
		font-size: 0.76rem;
	}

	.level-shape {
		display: flex;
		align-items: center;
		justify-content: center;
		justify-self: center;
		width: calc(16% + (var(--level-scale) * 84%));
		min-width: 34px;
		height: 20px;
		border: 1px solid var(--c-blue);
		background: var(--level-gradient);
		color: var(--c-bg);
		font-size: 0.68rem;
		font-weight: 700;
		line-height: 1;
	}

	.level-link-active .level-shape {
		border-color: var(--c-orange);
		box-shadow: 0 0 0 1px var(--c-orange);
	}

	.focus-columns {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 12px;
	}

	.focus-block {
		display: grid;
		gap: 8px;
		min-width: 0;
	}

	.zone-chip-list,
	.group-level-links {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.zone-chip,
	.zone-set-chip,
	.group-level-links a {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		border: 1px solid var(--c-blue);
		border-radius: 4px;
		padding: 0.24rem 0.42rem;
		font-size: 0.74rem;
		color: var(--c-ice);
	}

	.zone-chip {
		background: var(--zone-gradient);
		color: var(--c-bg);
		font-weight: 700;
	}

	.zone-chip span {
		background: color-mix(in srgb, var(--c-ice) 78%, transparent);
		padding: 0 0.18rem;
	}

	.zone-set-chip:hover,
	.group-level-links a:hover {
		border-color: var(--c-yellow);
		color: var(--c-yellow);
	}

	.weight-list {
		display: grid;
		gap: 6px;
	}

	.weight-row {
		display: grid;
		grid-template-columns: 2rem minmax(4rem, 1fr) 2.5rem minmax(4rem, 1.2fr);
		align-items: center;
		gap: 7px;
		font-size: 0.72rem;
		color: var(--c-ice);
	}

	.weight-meter {
		display: block;
		height: 8px;
		border: 1px solid var(--c-blue);
	}

	.weight-meter span {
		display: block;
		width: calc(var(--weight-percent) * 1%);
		height: 100%;
		background: var(--c-cyan);
	}

	.compact-table-wrap table {
		table-layout: auto;
	}

	.compact-table-wrap th,
	.compact-table-wrap td {
		padding: 0.34rem 0.45rem;
		font-size: 0.72rem;
	}

	.level-group-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 8px;
	}

	.level-group {
		display: grid;
		gap: 8px;
		border: 1px solid var(--c-blue);
		border-radius: 6px;
		padding: 9px;
		color: var(--c-ice);
	}

	.level-group:hover,
	.level-group:focus-visible,
	.level-group-active {
		border-color: var(--c-orange);
		color: var(--c-orange);
	}

	.level-group-levels {
		font-size: 0.78rem;
	}

	.level-group-zones {
		color: var(--c-sand);
		font-size: 0.72rem;
		line-height: 1.35;
	}

	.catalog-section table {
		table-layout: auto;
	}

	.catalog-section th a {
		color: var(--c-pink);
	}

	.catalog-section th a:hover,
	.catalog-section th a:focus-visible {
		color: var(--c-yellow);
	}

	.palette-strip {
		display: block;
		width: min(160px, 36vw);
		height: 16px;
		border: 1px solid var(--c-blue);
		background: var(--zone-gradient);
	}

	.biome-glyphs {
		font-family: 'Mathcastles Remix', 'Courier New', monospace;
		letter-spacing: 0;
		white-space: nowrap;
	}

	@media (max-width: 820px) {
		.hypercastle-workbench {
			grid-template-columns: 1fr;
		}

		.level-link {
			grid-template-columns: 2.5rem minmax(0, 1fr) 3.8rem;
		}

		.weight-row {
			grid-template-columns: 2rem minmax(4rem, 1fr) 2.4rem;
		}

		.weight-row span:last-child {
			grid-column: 1 / -1;
		}
	}
</style>
