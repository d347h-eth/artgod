<script lang="ts">
	import { onMount } from 'svelte';
	import type {
		ApiChain,
		ApiCollection,
		ApiCollectionMediaState,
		ApiTokenCard
	} from '$lib/api-types';
	import { getCollectionDetail } from '$lib/backend-api';
	import TokenCardTile from '$lib/components/TokenCardTile.svelte';
	import { getTokenPreviewController } from '$lib/components/token-preview-controller';
	import TerraformsSurfaceRerollIcon from '$lib/collection-extension-pages/terraforms/TerraformsSurfaceRerollIcon.svelte';
	import {
		buildTerraformsHypercastleTokenHref,
		buildTerraformsSeedClassSampleQuery,
		buildTerraformsSeedClassTokenHref,
		resolveTerraformsSeedClassCardMediaMode,
		resolveTerraformsSeedClassPreviewMediaMode,
		sampleTerraformsSeedClassTokenCards,
		TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM,
		TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS,
		TERRAFORMS_HYPERCASTLE_SEED_CLASS_ROWS,
		TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_STATUS,
		type TerraformsHypercastleSeedClassRow,
		type TerraformsHypercastleSeedClassSampleState
	} from '$lib/collection-extension-pages/terraforms/hypercastle-seed-classes';

	let {
		chain,
		collection,
		media,
		basePath
	}: {
		chain: ApiChain;
		collection: ApiCollection;
		media: ApiCollectionMediaState;
		basePath: string;
	} = $props();

	const tokenPreview = getTokenPreviewController();
	let sampleStateBySeedClass = $state<Record<string, TerraformsHypercastleSeedClassSampleState>>(
		initialSampleStateBySeedClass()
	);
	let cardMediaMode = $derived(resolveTerraformsSeedClassCardMediaMode(media));
	let previewMediaMode = $derived(resolveTerraformsSeedClassPreviewMediaMode(media));

	onMount(() => {
		let cancelled = false;
		void loadSeedClassSamples(() => cancelled);
		return () => {
			cancelled = true;
		};
	});

	function seedClassHref(seedClass: string): string {
		return buildTerraformsSeedClassTokenHref({
			basePath,
			mediaMode: media.selectedMode,
			seedClass
		});
	}

	function tokenHref(tokenId: string): string {
		return buildTerraformsHypercastleTokenHref({
			basePath,
			tokenId,
			mediaMode: media.selectedMode
		});
	}

	function initialSampleStateBySeedClass(): Record<string, TerraformsHypercastleSeedClassSampleState> {
		return Object.fromEntries(
			TERRAFORMS_HYPERCASTLE_SEED_CLASS_ROWS.map((row) => [
				row.traitValue,
				{
					status: TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_STATUS.Idle,
					pool: [],
					visible: []
				}
			])
		);
	}

	async function loadSeedClassSamples(cancelled: () => boolean): Promise<void> {
		await Promise.all(
			TERRAFORMS_HYPERCASTLE_SEED_CLASS_ROWS.map(async (row) => {
				updateSampleState(row.traitValue, {
					status: TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_STATUS.Loading
				});
				try {
					const response = await getCollectionDetail(
						fetch,
						chain.slug,
						collection.slug,
						buildTerraformsSeedClassSampleQuery({
							mediaMode: cardMediaMode,
							seedClass: row.traitValue
						})
					);
					if (cancelled()) return;
					updateSampleState(row.traitValue, {
						status: TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_STATUS.Ready,
						pool: response.tokens.items,
						visible: row.rerollable
							? sampleTerraformsSeedClassTokenCards(response.tokens.items)
							: response.tokens.items
					});
				} catch {
					if (cancelled()) return;
					updateSampleState(row.traitValue, {
						status: TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_STATUS.Error
					});
				}
			})
		);
	}

	function rerollSeedClassSamples(row: TerraformsHypercastleSeedClassRow): void {
		const state = sampleState(row);
		if (!row.rerollable || state.pool.length === 0) return;
		updateSampleState(row.traitValue, {
			visible: sampleTerraformsSeedClassTokenCards(state.pool)
		});
	}

	function updateSampleState(
		seedClass: string,
		patch: Partial<TerraformsHypercastleSeedClassSampleState>
	): void {
		sampleStateBySeedClass = {
			...sampleStateBySeedClass,
			[seedClass]: {
				...sampleStateBySeedClass[seedClass],
				...patch
			}
		};
	}

	function sampleState(row: TerraformsHypercastleSeedClassRow): TerraformsHypercastleSeedClassSampleState {
		return sampleStateBySeedClass[row.traitValue];
	}

	function showSampleStatus(state: TerraformsHypercastleSeedClassSampleState): boolean {
		return (
			state.status !== TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_STATUS.Ready ||
			state.visible.length === 0
		);
	}

	function sampleStatusLabel(state: TerraformsHypercastleSeedClassSampleState): string {
		if (state.status === TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_STATUS.Loading) {
			return TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.SampleLoading;
		}
		if (state.status === TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_STATUS.Error) {
			return TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.SampleError;
		}
		return TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.SampleEmpty;
	}

	function sampleAdjacentTokenId(
		row: TerraformsHypercastleSeedClassRow,
		step: -1 | 1,
		currentTokenId: string
	): string | null {
		const sample = sampleState(row).visible;
		const index = sample.findIndex((token) => token.tokenId === currentTokenId);
		if (index < 0) return null;
		return sample[index + step]?.tokenId ?? null;
	}
</script>

<article
	class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.root}
	data-testid={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.testIds.root}
>
	<section class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.section}>
		<h2 class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.heading}>
			{TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.Heading}
		</h2>
		<h3 class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.subheading}>
			{TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.SeedTraitsHeading}
		</h3>
		<p class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.copy}>
			{TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.SeedTraitCopy}
		</p>
	</section>

	<section class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.section}>
		<h3 class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.subheading}>
			{TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.SeedClassesHeading}
		</h3>
		<div
			class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.list}
			data-testid={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.testIds.seedClassList}
		>
			{#each TERRAFORMS_HYPERCASTLE_SEED_CLASS_ROWS as row (row.key)}
				{@const state = sampleState(row)}
				<section
					class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.block}
					data-testid={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.testIds.seedClassBlock}
				>
					<div class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.blockHeader}>
						<a
							class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.classLink}
							href={seedClassHref(row.traitValue)}
						>
							{row.label}
						</a>
						{#if row.rerollable}
							<button
								type="button"
								class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.rerollButton}
								data-testid={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.testIds.rerollButton}
								title={TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.Reroll}
								aria-label={`${TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.Reroll} ${row.label}`}
								disabled={state.status !== TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_STATUS.Ready ||
									state.pool.length <= state.visible.length}
								onclick={() => rerollSeedClassSamples(row)}
							>
								<TerraformsSurfaceRerollIcon />
							</button>
						{/if}
					</div>
					<p class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.condition}>{row.condition}</p>
					<p class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.copy}>{row.summary}</p>
					{#if showSampleStatus(state)}
						<div class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.status}>
							{sampleStatusLabel(state)}
						</div>
					{:else}
						<div
							class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.sampleGrid}
							data-testid={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.testIds.sampleGrid}
						>
							{#each state.visible as token (token.tokenId)}
								<TokenCardTile
									{chain}
									{collection}
									{token}
									href={tokenHref(token.tokenId)}
									selectedMediaMode={previewMediaMode}
									availableMediaModes={media.availableModes}
									{tokenPreview}
									adjacentTokenResolver={(step, currentTokenId) =>
										sampleAdjacentTokenId(row, step, currentTokenId)}
								/>
							{/each}
						</div>
					{/if}
				</section>
			{/each}
		</div>
	</section>
</article>

<style>
	.terraforms-hypercastle-seed-classes {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		row-gap: 1.1rem;
		max-width: min(100%, 1120px);
	}

	.terraforms-hypercastle-seed-classes-section {
		min-width: 0;
	}

	.terraforms-hypercastle-seed-classes-heading {
		margin: 0 0 0.55rem;
		font-size: 1rem;
		font-weight: 600;
		color: var(--c-ice);
		letter-spacing: 0;
	}

	.terraforms-hypercastle-seed-classes-subheading {
		margin: 0 0 0.4rem;
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--c-pink);
		text-transform: uppercase;
		letter-spacing: 0;
	}

	.terraforms-hypercastle-seed-classes-copy {
		max-width: 72rem;
		margin: 0;
		font-size: 0.82rem;
		line-height: 1.45;
	}

	.terraforms-hypercastle-seed-classes-list {
		display: grid;
		gap: 1.6rem;
	}

	.terraforms-hypercastle-seed-classes-block {
		display: grid;
		gap: 0.4rem;
		min-width: 0;
	}

	.terraforms-hypercastle-seed-classes-block-header {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		flex-wrap: wrap;
	}

	.terraforms-hypercastle-seed-classes-class-link {
		color: var(--c-cyan);
		text-decoration: underline;
		text-decoration-thickness: 1px;
		text-underline-offset: 2px;
		font-size: 0.9rem;
		font-weight: 600;
	}

	.terraforms-hypercastle-seed-classes-class-link:hover,
	.terraforms-hypercastle-seed-classes-class-link:focus-visible {
		color: var(--c-yellow);
	}

	.terraforms-hypercastle-seed-classes-reroll-button {
		width: 20px;
		min-width: 20px;
		min-height: 20px;
		padding: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.terraforms-hypercastle-seed-classes-condition {
		margin: 0;
		color: var(--c-sand);
		font-size: 0.74rem;
		line-height: 1.35;
	}

	.terraforms-hypercastle-seed-classes-sample-grid {
		--token-grid-media-height: 210px;
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.8rem;
		width: min(100%, 760px);
		justify-self: center;
		margin-top: 0.45rem;
	}

	.terraforms-hypercastle-seed-classes-status {
		width: fit-content;
		margin-top: 0.45rem;
		color: var(--c-sand);
		font-size: 0.74rem;
	}

	@media (max-width: 980px) {
		.terraforms-hypercastle-seed-classes-sample-grid {
			--token-grid-media-height: 180px;
			grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr));
			width: min(100%, 560px);
		}
	}
</style>
