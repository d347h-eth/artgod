<script lang="ts">
	import type { ApiTokenAttribute, ApiTraitRangeFilter } from '$lib/api-types';

	type MaybePromise<T> = T | Promise<T>;
	type TraitFilterSlug =
		| {
				kind: 'trait';
				key: string;
				value: string;
				label: string;
				title: string;
			}
		| {
				kind: 'range';
				key: string;
				label: string;
				title: string;
			};

	const MAX_LABEL_LENGTH = 20;

	let {
		selectedTraits = [],
		selectedRanges = [],
		onRemoveTrait,
		onRemoveRange
	}: {
		selectedTraits?: ApiTokenAttribute[];
		selectedRanges?: ApiTraitRangeFilter[];
		onRemoveTrait: (trait: ApiTokenAttribute) => MaybePromise<void>;
		onRemoveRange: (range: ApiTraitRangeFilter) => MaybePromise<void>;
	} = $props();

	const slugs = $derived(resolveSlugs(selectedTraits, selectedRanges));

	function resolveSlugs(
		traits: ApiTokenAttribute[],
		ranges: ApiTraitRangeFilter[]
	): TraitFilterSlug[] {
		return [
			...traits.map((trait) => {
				const label = `${trait.key}=${trait.value}`;
				return {
					kind: 'trait' as const,
					key: trait.key,
					value: trait.value,
					label,
					title: label
				};
			}),
			...ranges.map((range) => {
				const fromValue = range.fromValue ?? '';
				const toValue = range.toValue ?? '';
				const label = `${range.key}=${fromValue}..${toValue}`;
				return {
					kind: 'range' as const,
					key: range.key,
					label,
					title: label
				};
			})
		];
	}

	function clippedLabel(label: string): string {
		return label.length <= MAX_LABEL_LENGTH
			? label
			: `${label.slice(0, MAX_LABEL_LENGTH - 3)}...`;
	}

	function removeSlug(slug: TraitFilterSlug): void {
		if (slug.kind === 'trait') {
			void onRemoveTrait({ key: slug.key, value: slug.value });
			return;
		}
		const range = selectedRanges.find((item) => item.key === slug.key);
		if (range) {
			void onRemoveRange(range);
		}
	}
</script>

{#if slugs.length > 0}
	<div class="trait-filter-slugs" aria-label="Selected trait filters">
		{#each slugs as slug (`${slug.kind}:${slug.key}:${slug.kind === 'trait' ? slug.value : ''}`)}
			<button
				type="button"
				class="facet-panel-action-button facet-reset-button trait-filter-slug"
				title={slug.title}
				aria-label={`remove ${slug.title}`}
				onclick={() => removeSlug(slug)}
			>
				<span class="trait-filter-slug-label">{clippedLabel(slug.label)}</span>
			</button>
		{/each}
	</div>
{/if}
