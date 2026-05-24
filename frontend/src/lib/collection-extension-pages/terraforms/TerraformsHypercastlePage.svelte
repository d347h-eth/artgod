<script lang="ts">
	import { page as routePage } from '$app/state';
	import {
		TERRAFORMS_BIOMES,
		TERRAFORMS_HYPERCASTLE_LEVEL_COUNT,
		TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS,
		TERRAFORMS_HYPERCASTLE_LEVELS,
		TERRAFORMS_HYPERCASTLE_MAX_LEVEL_DIMENSION,
		TERRAFORMS_HYPERCASTLE_TOTAL_PARCELS,
		TERRAFORMS_TOPOGRAPHY_BUCKET_COUNT,
		TERRAFORMS_ZONES,
		type TerraformsBiomeGroupWeight,
		type TerraformsLevelGroupSummary,
		type TerraformsLevelSummary,
		type TerraformsLevelZoneBucket,
		type TerraformsZone
	} from '@artgod/shared/extensions/terraforms';
	import type { CollectionExtensionPageProps } from '$lib/collection-extension-pages/types';
	import TerraformsHypercastleIsometricLevel from '$lib/collection-extension-pages/terraforms/TerraformsHypercastleIsometricLevel.svelte';
	import {
		TERRAFORMS_HYPERCASTLE_ARIA_LABELS,
		TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES,
		TERRAFORMS_HYPERCASTLE_LABELS,
		TERRAFORMS_HYPERCASTLE_NUMBER_FORMAT_LOCALE
	} from '$lib/collection-extension-pages/terraforms/constants';
	import {
		buildTerraformsHypercastleHref,
		resolveTerraformsHypercastleState,
		type TerraformsHypercastleHrefUpdate
	} from '$lib/collection-extension-pages/terraforms/hypercastle-catalog';
	import {
		buildTerraformsHypercastleIsometricRenderKey,
		resolveTerraformsHypercastleSelectedBucket
	} from '$lib/collection-extension-pages/terraforms/hypercastle-isometric-level';

	let { collection, page }: CollectionExtensionPageProps = $props();
	let selectedTopographyBucketIndex = $state<number | null>(null);

	const explorerState = $derived(resolveTerraformsHypercastleState(routePage.url.searchParams));
	const selectedGroupLevels = $derived(
		explorerState.selectedGroup
			? explorerState.selectedGroup.levelNumbers.map((levelNumber) => levelByNumber(levelNumber))
			: []
	);
	const selectedTopographyBucket = $derived(
		explorerState.selectedLevel
			? resolveTerraformsHypercastleSelectedBucket(
					explorerState.selectedLevel,
					selectedTopographyBucketIndex
				)
			: null
	);
	const selectedTopographyZone = $derived(
		selectedTopographyBucket ? zoneForBucket(selectedTopographyBucket) : null
	);

	$effect(() => {
		if (!explorerState.selectedLevel) {
			if (selectedTopographyBucketIndex !== null) selectedTopographyBucketIndex = null;
			return;
		}
		const bucket = resolveTerraformsHypercastleSelectedBucket(
			explorerState.selectedLevel,
			selectedTopographyBucketIndex
		);
		if (bucket.topographyBucketIndex !== selectedTopographyBucketIndex) {
			selectedTopographyBucketIndex = bucket.topographyBucketIndex;
		}
	});

	function explorerHref(update: TerraformsHypercastleHrefUpdate): string {
		return buildTerraformsHypercastleHref(
			routePage.url.pathname,
			routePage.url.searchParams,
			update
		);
	}

	function groupHref(group: TerraformsLevelGroupSummary): string {
		return explorerHref({ groupId: group.groupId, levelNumber: null });
	}

	function levelHref(level: TerraformsLevelSummary): string {
		return explorerHref({ levelNumber: level.levelNumber });
	}

	function levelDrillHref(level: TerraformsLevelSummary): string {
		const group = groupForLevel(level);
		if (explorerState.selectedGroup?.levelNumbers.includes(level.levelNumber)) {
			return levelHref(level);
		}
		return groupHref(group);
	}

	function clearFocusHref(): string {
		return explorerHref({ groupId: null, levelNumber: null });
	}

	function selectTopographyBucket(bucket: TerraformsLevelZoneBucket): void {
		selectedTopographyBucketIndex = bucket.topographyBucketIndex;
	}

	function levelByNumber(levelNumber: number): TerraformsLevelSummary {
		return TERRAFORMS_HYPERCASTLE_LEVELS[levelNumber - 1]!;
	}

	function groupForLevel(level: TerraformsLevelSummary): TerraformsLevelGroupSummary {
		return TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS.find((group) =>
			group.levelNumbers.includes(level.levelNumber)
		)!;
	}

	function zoneForBucket(bucket: TerraformsLevelZoneBucket): TerraformsZone {
		return TERRAFORMS_ZONES[bucket.zoneIndex]!;
	}

	function levelPlateStyle(level: TerraformsLevelSummary): string {
		return [
			`--level-scale: ${level.dimension / TERRAFORMS_HYPERCASTLE_MAX_LEVEL_DIMENSION}`,
			`--level-gradient: ${zoneGradient(level.zones)}`
		].join('; ');
	}

	function groupStyle(group: TerraformsLevelGroupSummary): string {
		return `--group-gradient: ${zoneGradient(group.zoneIndices.map((zoneIndex) => TERRAFORMS_ZONES[zoneIndex]!))}`;
	}

	function zoneStyle(zone: TerraformsZone): string {
		return `--zone-gradient: ${paletteGradient(zone.palette)}`;
	}

	function topographyBandStyle(bucket: TerraformsLevelZoneBucket): string {
		return [
			`--zone-gradient: ${paletteGradient(zoneForBucket(bucket).palette)}`,
			`--band-scale: ${(bucket.topographyBucketIndex + 1) / TERRAFORMS_TOPOGRAPHY_BUCKET_COUNT}`
		].join('; ');
	}

	function biomeWeightStyle(weight: TerraformsBiomeGroupWeight): string {
		return `--weight-percent: ${weight.weightPercent}`;
	}

	function zoneGradient(zones: readonly TerraformsZone[]): string {
		if (zones.length === 1) return paletteGradient(zones[0]!.palette);
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

	function formatInteger(value: number): string {
		return value.toLocaleString(TERRAFORMS_HYPERCASTLE_NUMBER_FORMAT_LOCALE);
	}

	function formatLevels(levelNumbers: readonly number[]): string {
		return levelNumbers
			.map((levelNumber) => `${TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.Level}${levelNumber}`)
			.join(' ');
	}

	function formatBiomeRange(indices: readonly number[]): string {
		if (indices.length === 0) return '';
		const first = indices[0]!;
		const last = indices[indices.length - 1]!;
		if (first === last) return `${TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.Biome}${first}`;
		return `${TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.Biome}${first}-${TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.Biome}${last}`;
	}

	function formatThreshold(value: number | null): string {
		return value === null ? TERRAFORMS_HYPERCASTLE_LABELS.Base : `>${formatInteger(value)}`;
	}

	function availableBiomeCount(level: TerraformsLevelSummary): number {
		return new Set(level.availableBiomeGroupWeights.flatMap((weight) => weight.biomeIndices)).size;
	}
</script>

<section class="terraforms-hypercastle-page" data-extension-key={page.extensionKey}>
	<header class="hypercastle-header">
		<div class="hypercastle-title">
			<h1>{TERRAFORMS_HYPERCASTLE_LABELS.Hypercastle}</h1>
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

	<section class="hypercastle-stage" aria-label={TERRAFORMS_HYPERCASTLE_ARIA_LABELS.Structure}>
		<section class="hypercastle-stack-panel" aria-label={TERRAFORMS_HYPERCASTLE_ARIA_LABELS.LevelStack}>
			<header class="section-heading">
				<h2>{TERRAFORMS_HYPERCASTLE_LABELS.Levels}</h2>
				{#if explorerState.selectedGroup || explorerState.selectedLevel}
					<a href={clearFocusHref()}>{TERRAFORMS_HYPERCASTLE_LABELS.All}</a>
				{/if}
			</header>
			<div class="hypercastle-stack">
				{#each TERRAFORMS_HYPERCASTLE_LEVELS as level (level.levelNumber)}
					<a
						href={levelDrillHref(level)}
						class="level-plate"
						class:level-plate-active={explorerState.selectedLevel?.levelNumber === level.levelNumber}
						class:level-plate-in-group={explorerState.selectedGroup?.levelNumbers.includes(
							level.levelNumber
						) && explorerState.selectedLevel?.levelNumber !== level.levelNumber}
						class:level-plate-muted={explorerState.selectedGroup &&
							!explorerState.selectedGroup.levelNumbers.includes(level.levelNumber)}
						style={levelPlateStyle(level)}
					>
						<span class="level-number">{TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.Level}{level.levelNumber}</span>
						<span class="level-surface"></span>
						<span class="level-breakdown">
							{TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.Zone}{level.zones.length}
							{TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.Biome}{availableBiomeCount(level)}
						</span>
					</a>
				{/each}
			</div>
		</section>

		<section class="hypercastle-drilldown" aria-label={TERRAFORMS_HYPERCASTLE_ARIA_LABELS.Focus}>
			{#if explorerState.selectedLevel}
				<header class="section-heading">
					<h2>{TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.Level}{explorerState.selectedLevel.levelNumber}</h2>
					{#if explorerState.selectedGroup}
						<a href={groupHref(explorerState.selectedGroup)}>{explorerState.selectedGroup.groupId}</a>
					{/if}
				</header>

				<div class="level-focus-grid">
					<TerraformsHypercastleIsometricLevel
						level={explorerState.selectedLevel}
						selectedBucketIndex={selectedTopographyBucket?.topographyBucketIndex ?? null}
						renderKey={buildTerraformsHypercastleIsometricRenderKey(
							explorerState.selectedLevel,
							selectedTopographyBucket
						)}
						onBucketSelect={selectTopographyBucket}
					/>

					<div class="focus-metrics">
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
							<strong>{availableBiomeCount(explorerState.selectedLevel)}</strong>
							<span>{TERRAFORMS_HYPERCASTLE_LABELS.AvailableBiomes}</span>
						</div>
					</div>
				</div>

				{#if selectedTopographyBucket && selectedTopographyZone}
					<section class="selected-band-panel" style={zoneStyle(selectedTopographyZone)}>
						<header class="section-heading">
							<h3>{TERRAFORMS_HYPERCASTLE_LABELS.SelectedBand}</h3>
							<span>{TERRAFORMS_HYPERCASTLE_LABELS.Band} {selectedTopographyBucket.topographyBucketIndex}</span>
						</header>
						<div class="selected-band-grid">
							<div class="zone-chip">
								<span>{selectedTopographyBucket.zoneName}</span>
							</div>
							<div>
								<strong>{selectedTopographyBucket.elevation}</strong>
								<span>{TERRAFORMS_HYPERCASTLE_LABELS.Elevation}</span>
							</div>
							<div>
								<strong>{formatThreshold(selectedTopographyBucket.thresholdGreaterThan)}</strong>
								<span>{TERRAFORMS_HYPERCASTLE_LABELS.Threshold}</span>
							</div>
						</div>
					</section>
				{/if}

				<section class="visual-detail-grid">
					<div class="visual-detail-block">
						<header class="section-heading">
							<h3>{TERRAFORMS_HYPERCASTLE_LABELS.ZoneWindow}</h3>
						</header>
						<div class="zone-chip-list">
							{#each explorerState.selectedLevel.zones as zone (zone.index)}
								<span class="zone-chip" style={zoneStyle(zone)}>
									<span>{zone.name}</span>
								</span>
							{/each}
						</div>
					</div>

					<div class="visual-detail-block">
						<header class="section-heading">
							<h3>{TERRAFORMS_HYPERCASTLE_LABELS.BiomeWeights}</h3>
						</header>
						<div class="biome-weight-stack">
							{#each explorerState.selectedLevel.availableBiomeGroupWeights as weight (weight.groupIndex)}
								<div class="biome-weight" style={biomeWeightStyle(weight)}>
									<span>{TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.BiomeGroup}{weight.groupIndex}</span>
									<span class="weight-meter"><span></span></span>
									<strong>{weight.weightPercent}%</strong>
									<span>{formatBiomeRange(weight.biomeIndices)}</span>
								</div>
							{/each}
						</div>
					</div>

					<div class="visual-detail-block visual-detail-block-wide">
						<header class="section-heading">
							<h3>{TERRAFORMS_HYPERCASTLE_LABELS.TopographyBands}</h3>
						</header>
						<div class="topography-band-grid" aria-label={TERRAFORMS_HYPERCASTLE_ARIA_LABELS.TopographyBands}>
							{#each explorerState.selectedLevel.topographyZoneBuckets as bucket (bucket.topographyBucketIndex)}
								<button
									type="button"
									class="topography-band"
									class:topography-band-active={selectedTopographyBucket?.topographyBucketIndex ===
										bucket.topographyBucketIndex}
									style={topographyBandStyle(bucket)}
									onclick={() => selectTopographyBucket(bucket)}
								>
									<span>{TERRAFORMS_HYPERCASTLE_LABELS.Band} {bucket.topographyBucketIndex}</span>
									<strong>{bucket.zoneName}</strong>
									<span>{TERRAFORMS_HYPERCASTLE_LABELS.Elevation} {bucket.elevation}</span>
								</button>
							{/each}
						</div>
					</div>
				</section>
			{:else if explorerState.selectedGroup}
				<header class="section-heading">
					<h2>{explorerState.selectedGroup.groupId}</h2>
					<a href={clearFocusHref()}>{TERRAFORMS_HYPERCASTLE_LABELS.All}</a>
				</header>
				<div class="group-focus" style={groupStyle(explorerState.selectedGroup)}>
					<div class="group-focus-band"></div>
					<div class="group-focus-metrics">
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
					</div>
				</div>
				<div class="group-level-grid">
					{#each selectedGroupLevels as level (level.levelNumber)}
						<a href={levelHref(level)} class="group-level-card" style={levelPlateStyle(level)}>
							<span>{TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.Level}{level.levelNumber}</span>
							<span class="level-card-surface"></span>
							<strong>{level.dimension}x{level.dimension}</strong>
							<span>
								{TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.Zone}{level.zones.length}
								{TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.Biome}{availableBiomeCount(level)}
							</span>
						</a>
					{/each}
				</div>
				<div class="zone-chip-list">
					{#each explorerState.selectedGroup.zoneIndices as zoneIndex}
						{@const zone = TERRAFORMS_ZONES[zoneIndex]!}
						<span class="zone-chip" style={zoneStyle(zone)}>
							<span>{zone.name}</span>
						</span>
					{/each}
				</div>
			{:else}
				<header class="section-heading">
					<h2>{TERRAFORMS_HYPERCASTLE_LABELS.ZoneSets}</h2>
				</header>
				<div class="zone-set-grid" aria-label={TERRAFORMS_HYPERCASTLE_ARIA_LABELS.GroupDrilldown}>
					{#each TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS as group (group.groupId)}
						<a href={groupHref(group)} class="zone-set-card" style={groupStyle(group)}>
							<span class="zone-set-card-band"></span>
							<strong>{formatLevels(group.levelNumbers)}</strong>
							<span>{group.zoneNames.length} {TERRAFORMS_HYPERCASTLE_LABELS.Zones}</span>
							<span>{formatInteger(group.totalParcels)} {TERRAFORMS_HYPERCASTLE_LABELS.Parcels}</span>
						</a>
					{/each}
				</div>
			{/if}
		</section>
	</section>
</section>

<style>
	.terraforms-hypercastle-page {
		display: grid;
		gap: 16px;
		padding: 18px 0 4px;
	}

	.hypercastle-header {
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
	.section-heading h3 {
		margin: 0;
		font-weight: 650;
		line-height: 1.1;
		text-transform: uppercase;
	}

	.hypercastle-title h1 {
		font-size: 1.45rem;
	}

	.section-heading h2 {
		color: var(--c-pink);
		font-size: 0.95rem;
	}

	.section-heading h3 {
		color: var(--c-pink);
		font-size: 0.75rem;
	}

	.hypercastle-title span,
	.section-heading span,
	.section-heading a {
		color: var(--c-sand);
		font-size: 0.8rem;
	}

	.hypercastle-stats,
	.focus-metrics,
	.group-focus-metrics,
	.selected-band-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.hypercastle-stats div,
	.focus-metrics div,
	.group-focus-metrics div,
	.selected-band-grid div:not(.zone-chip) {
		display: grid;
		min-width: 78px;
		gap: 2px;
		border: 1px solid var(--c-blue);
		border-radius: 6px;
		padding: 8px 10px;
	}

	.hypercastle-stats strong,
	.focus-metrics strong,
	.group-focus-metrics strong,
	.selected-band-grid strong {
		font-size: 1rem;
		font-weight: 650;
	}

	.hypercastle-stats span,
	.focus-metrics span,
	.group-focus-metrics span,
	.selected-band-grid span {
		color: var(--c-sand);
		font-size: 0.76rem;
	}

	.hypercastle-stage {
		display: grid;
		grid-template-columns: minmax(320px, 0.96fr) minmax(330px, 0.82fr);
		gap: 18px;
		align-items: start;
	}

	.hypercastle-stack-panel,
	.hypercastle-drilldown,
	.visual-detail-block,
	.selected-band-panel {
		display: grid;
		gap: 10px;
		min-width: 0;
	}

	.hypercastle-stack {
		display: grid;
		gap: 4px;
		justify-items: center;
		padding: 8px 0;
	}

	.level-plate {
		display: grid;
		grid-template-columns: 2.3rem minmax(0, 1fr) 4.2rem;
		align-items: center;
		gap: 8px;
		width: calc(82px + (var(--level-scale) * 420px));
		max-width: 100%;
		min-height: 23px;
		color: var(--c-ice);
	}

	.level-plate:hover,
	.level-plate:focus-visible {
		color: var(--c-yellow);
	}

	.level-plate-muted {
		opacity: 0.34;
	}

	.level-plate-active,
	.level-plate-in-group {
		color: var(--c-orange);
		opacity: 1;
	}

	.level-number,
	.level-breakdown {
		font-size: 0.7rem;
		white-space: nowrap;
	}

	.level-surface,
	.level-card-surface,
	.zone-set-card-band,
	.group-focus-band {
		display: block;
		border: 1px solid var(--c-blue);
		background: var(--level-gradient, var(--group-gradient));
	}

	.level-surface {
		height: 18px;
		box-shadow: 0 4px 0 color-mix(in srgb, var(--c-blue) 42%, transparent);
		transform: skewX(-18deg);
	}

	.level-plate-active .level-surface,
	.level-plate-in-group .level-surface {
		border-color: var(--c-orange);
		box-shadow: 0 4px 0 color-mix(in srgb, var(--c-orange) 58%, transparent);
	}

	.level-focus-grid {
		display: grid;
		grid-template-columns: minmax(300px, 1fr);
		gap: 10px;
	}

	.group-focus {
		display: grid;
		gap: 10px;
	}

	.group-focus-band {
		height: 34px;
		background: var(--group-gradient);
	}

	.group-level-grid,
	.zone-set-grid,
	.visual-detail-grid {
		display: grid;
		gap: 8px;
	}

	.group-level-grid {
		grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
	}

	.group-level-card,
	.zone-set-card {
		display: grid;
		gap: 7px;
		border: 1px solid var(--c-blue);
		border-radius: 6px;
		padding: 8px;
		color: var(--c-ice);
	}

	.group-level-card:hover,
	.group-level-card:focus-visible,
	.zone-set-card:hover,
	.zone-set-card:focus-visible {
		border-color: var(--c-yellow);
		color: var(--c-yellow);
	}

	.level-card-surface {
		width: calc(26px + (var(--level-scale) * 92px));
		height: 18px;
		background: var(--level-gradient);
	}

	.group-level-card strong,
	.zone-set-card strong {
		font-size: 0.8rem;
		font-weight: 650;
	}

	.group-level-card span,
	.zone-set-card span {
		color: var(--c-sand);
		font-size: 0.72rem;
	}

	.zone-set-grid {
		grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
	}

	.zone-set-card-band {
		height: 22px;
		background: var(--group-gradient);
	}

	.selected-band-panel {
		border: 1px solid var(--c-blue);
		border-radius: 6px;
		padding: 10px;
	}

	.selected-band-grid {
		align-items: center;
	}

	.visual-detail-grid {
		grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
	}

	.visual-detail-block-wide {
		grid-column: 1 / -1;
	}

	.zone-chip-list {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.zone-chip {
		display: inline-flex;
		align-items: center;
		width: fit-content;
		min-height: 24px;
		border: 1px solid var(--c-blue);
		border-radius: 4px;
		padding: 0.24rem 0.42rem;
		background: var(--zone-gradient);
		color: var(--c-bg);
		font-size: 0.74rem;
		font-weight: 700;
	}

	.zone-chip span {
		background: color-mix(in srgb, var(--c-ice) 78%, transparent);
		padding: 0 0.18rem;
	}

	.biome-weight-stack {
		display: grid;
		gap: 6px;
	}

	.biome-weight {
		display: grid;
		grid-template-columns: 2rem minmax(4rem, 1fr) 2.5rem minmax(4.5rem, 0.7fr);
		align-items: center;
		gap: 7px;
		font-size: 0.72rem;
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

	.topography-band-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
		gap: 6px;
	}

	.topography-band {
		display: grid;
		gap: 4px;
		min-height: 66px;
		border: 1px solid var(--c-blue);
		border-radius: 6px;
		padding: 8px;
		background:
			linear-gradient(
				90deg,
				color-mix(in srgb, var(--c-bg) 58%, transparent),
				color-mix(in srgb, var(--c-bg) calc(92% - (var(--band-scale) * 18%)), transparent)
			),
			var(--zone-gradient);
		color: var(--c-ice);
		text-align: left;
	}

	.topography-band:hover,
	.topography-band:focus-visible,
	.topography-band-active {
		border-color: var(--c-orange);
		color: var(--c-orange);
	}

	.topography-band span,
	.topography-band strong {
		font-size: 0.72rem;
	}

	.topography-band strong {
		font-weight: 650;
	}

	@media (max-width: 900px) {
		.hypercastle-stage {
			grid-template-columns: 1fr;
		}

		.level-plate {
			width: calc(74px + (var(--level-scale) * 78vw));
		}

		.biome-weight {
			grid-template-columns: 2rem minmax(4rem, 1fr) 2.5rem;
		}

		.biome-weight span:last-child {
			grid-column: 1 / -1;
		}
	}
</style>
