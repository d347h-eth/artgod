<script lang="ts">
	import type { CollectionExtensionPageProps } from '$lib/collection-extension-pages/types';
	import { TERRAFORMS_HYPERCASTLE_PAGE_ACTIONS } from '$lib/collection-extension-pages/terraforms/hypercastle-actions';
	import TerraformsSurfaceRerollIcon from '$lib/collection-extension-pages/terraforms/TerraformsSurfaceRerollIcon.svelte';
	import {
		TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_DOM,
		TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_LABELS
	} from '$lib/collection-extension-pages/terraforms/hypercastle-surface-texture';
	import { TERRAFORMS_LEVEL_ZONE_BUTTON_TYPES } from '$lib/collection-extension-pages/terraforms/level-zones';

	let { actions }: CollectionExtensionPageProps = $props();

	function rerollSurfaces(): void {
		actions.runAction(TERRAFORMS_HYPERCASTLE_PAGE_ACTIONS.RerollSurfaces);
	}
</script>

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

<style>
	.terraforms-hypercastle-surface-reroll {
		width: 20px;
		min-width: 20px;
		padding: 0;
	}
</style>
