<script lang="ts">
	import { page as routePage } from '$app/state';
	import type { CollectionExtensionPageProps } from '$lib/collection-extension-pages/types';
	import { TERRAFORMS_HYPERCASTLE_PAGE_ACTIONS } from '$lib/collection-extension-pages/terraforms/hypercastle-actions';
	import { COLLECTION_PAGE_TOP_ACTIONS_DOM } from '$lib/components/collection-page-layout-dom';
	import {
		buildTerraformsHypercastleSectionHref,
		formatTerraformsHypercastleSectionLabel,
		parseTerraformsHypercastleSection,
		TERRAFORMS_HYPERCASTLE_SECTION_DOM,
		TERRAFORMS_HYPERCASTLE_SECTION_LABELS,
		TERRAFORMS_HYPERCASTLE_SECTION_ORDER,
		TERRAFORMS_HYPERCASTLE_SECTION_QUERY_PARAMS,
		TERRAFORMS_HYPERCASTLE_SECTIONS,
		type TerraformsHypercastleSection
	} from '$lib/collection-extension-pages/terraforms/hypercastle-sections';
	import TerraformsSurfaceRerollIcon from '$lib/collection-extension-pages/terraforms/TerraformsSurfaceRerollIcon.svelte';
	import {
		TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_DOM,
		TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_LABELS
	} from '$lib/collection-extension-pages/terraforms/hypercastle-surface-texture';
	import { TERRAFORMS_LEVEL_ZONE_BUTTON_TYPES } from '$lib/collection-extension-pages/terraforms/level-zones';

	let { actions }: CollectionExtensionPageProps = $props();

	let activeSection = $derived(
		parseTerraformsHypercastleSection(
			routePage.url.searchParams.get(TERRAFORMS_HYPERCASTLE_SECTION_QUERY_PARAMS.Section)
		)
	);

	function rerollSurfaces(): void {
		actions.runAction(TERRAFORMS_HYPERCASTLE_PAGE_ACTIONS.RerollSurfaces);
	}

	function sectionHref(section: TerraformsHypercastleSection): string {
		return buildTerraformsHypercastleSectionHref(routePage.url, section);
	}
</script>

<div class={COLLECTION_PAGE_TOP_ACTIONS_DOM.classes.row}>
	<span class={COLLECTION_PAGE_TOP_ACTIONS_DOM.classes.label}>
		{TERRAFORMS_HYPERCASTLE_SECTION_LABELS.Control}
	</span>
	<div
		class="secondary-tabs"
		aria-label={TERRAFORMS_HYPERCASTLE_SECTION_LABELS.AriaLabel}
		data-testid={TERRAFORMS_HYPERCASTLE_SECTION_DOM.testIds.tabs}
	>
		{#each TERRAFORMS_HYPERCASTLE_SECTION_ORDER as section}
			{#if activeSection === section}
				<button type={TERRAFORMS_LEVEL_ZONE_BUTTON_TYPES.Button} class="secondary-tab-active" disabled>
					{formatTerraformsHypercastleSectionLabel(section)}
				</button>
			{:else}
				<a href={sectionHref(section)}>{formatTerraformsHypercastleSectionLabel(section)}</a>
			{/if}
		{/each}
	</div>
</div>

{#if activeSection === TERRAFORMS_HYPERCASTLE_SECTIONS.Structure}
	<div class={COLLECTION_PAGE_TOP_ACTIONS_DOM.classes.row}>
		<button
			type={TERRAFORMS_LEVEL_ZONE_BUTTON_TYPES.Button}
			class={`${TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_DOM.classes.rerollButton} facet-panel-action-button`}
			data-testid={TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_DOM.testIds.rerollButton}
			title={TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_LABELS.RerollSurfaces}
			aria-label={TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_LABELS.RerollSurfaces}
			onclick={rerollSurfaces}
		>
			<TerraformsSurfaceRerollIcon />
		</button>
	</div>
{/if}

<style>
	.terraforms-hypercastle-surface-reroll {
		width: 20px;
		min-width: 20px;
		padding: 0;
	}
</style>
