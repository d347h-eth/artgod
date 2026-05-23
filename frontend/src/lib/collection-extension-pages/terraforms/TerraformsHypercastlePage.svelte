<script lang="ts">
	import {
		TERRAFORMS_BIOMES,
		TERRAFORMS_HYPERCASTLE_LEVEL_COUNT,
		TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS,
		TERRAFORMS_HYPERCASTLE_TOTAL_PARCELS,
		TERRAFORMS_ZONES
	} from '@artgod/shared/extensions/terraforms';
	import type { CollectionExtensionPageProps } from '$lib/collection-extension-pages/types';

	let { collection, page }: CollectionExtensionPageProps = $props();
</script>

<section class="terraforms-hypercastle-page" data-extension-key={page.extensionKey}>
	<header class="hypercastle-header">
		<div class="hypercastle-title">
			<h1>Hypercastle</h1>
			<span>{collection.slug}</span>
		</div>
		<div class="hypercastle-stats" aria-label="Hypercastle contract totals">
			<div>
				<strong>{TERRAFORMS_HYPERCASTLE_LEVEL_COUNT}</strong>
				<span>levels</span>
			</div>
			<div>
				<strong>{TERRAFORMS_ZONES.length}</strong>
				<span>zones</span>
			</div>
			<div>
				<strong>{TERRAFORMS_BIOMES.length}</strong>
				<span>biomes</span>
			</div>
			<div>
				<strong>{TERRAFORMS_HYPERCASTLE_TOTAL_PARCELS}</strong>
				<span>parcels</span>
			</div>
		</div>
	</header>

	<section class="level-groups" aria-label="Hypercastle level groups">
		{#each TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS as group}
			<article class="level-group">
				<div class="level-group-levels">
					{#each group.levelNumbers as levelNumber}
						<span>L{levelNumber}</span>
					{/each}
				</div>
				<div class="level-group-zones">
					{#each group.zoneNames as zoneName}
						<span>{zoneName}</span>
					{/each}
				</div>
				<div class="level-group-meta">
					<span>{group.maxDimension}x{group.maxDimension}</span>
					<span>{group.totalParcels} parcels</span>
				</div>
			</article>
		{/each}
	</section>
</section>

<style>
	.terraforms-hypercastle-page {
		display: grid;
		gap: 18px;
		padding: 18px 0 4px;
	}

	.hypercastle-header {
		display: flex;
		flex-wrap: wrap;
		gap: 18px;
		align-items: end;
		justify-content: space-between;
	}

	.hypercastle-title {
		display: grid;
		gap: 2px;
	}

	.hypercastle-title h1 {
		margin: 0;
		font-size: 1.45rem;
		font-weight: 650;
		line-height: 1.1;
	}

	.hypercastle-title span,
	.level-group-meta {
		color: var(--c-sand);
		font-size: 0.8rem;
	}

	.hypercastle-stats {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.hypercastle-stats div {
		display: grid;
		min-width: 78px;
		gap: 2px;
		border: 1px solid var(--c-blue);
		border-radius: 6px;
		padding: 8px 10px;
	}

	.hypercastle-stats strong {
		font-size: 1rem;
		font-weight: 650;
	}

	.hypercastle-stats span {
		color: var(--c-sand);
		font-size: 0.76rem;
	}

	.level-groups {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 10px;
	}

	.level-group {
		display: grid;
		gap: 10px;
		border: 1px solid var(--c-blue);
		border-radius: 6px;
		padding: 10px;
	}

	.level-group-levels,
	.level-group-zones,
	.level-group-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.level-group-levels span {
		font-size: 0.78rem;
	}

	.level-group-zones span {
		font-size: 0.78rem;
	}
</style>
