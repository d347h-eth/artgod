<script lang="ts">
	import type { ApiTokenAttribute } from '$lib/api-types';
	import {
		TOKEN_PREVIEW_STATUS,
		type TokenPreviewState
	} from '$lib/components/token-preview-controller';
	import {
		clipTokenPreviewTraitText,
		tokenPreviewTraitPage,
		TOKEN_PREVIEW_TRAITS_LIMITS,
		TOKEN_PREVIEW_TRAITS_MODE
	} from '$lib/token-preview-traits';

	let {
		state,
		traitHref,
		onCycle,
		onNavigate,
		hovered,
		onpointerenter,
		onpointerleave
	}: {
		state: Pick<TokenPreviewState, 'attributes' | 'traitSummary' | 'traitDisplay' | 'status'>;
		traitHref: (trait: ApiTokenAttribute) => string | null;
		onCycle: () => void;
		onNavigate: () => void;
		hovered: boolean;
		onpointerenter: (event: PointerEvent) => void;
		onpointerleave: () => void;
	} = $props();

	const rows = $derived(tokenPreviewTraitPage(state.attributes, state.traitDisplay));

	function onTraitClick(event: MouseEvent): void {
		if (
			event.defaultPrevented ||
			event.button !== 0 ||
			event.ctrlKey ||
			event.metaKey ||
			event.shiftKey ||
			event.altKey
		) return;
		onNavigate();
	}
</script>

<div class="token-preview-traits">
	{#if state.status === TOKEN_PREVIEW_STATUS.Ready}
		{#if state.traitDisplay.mode === TOKEN_PREVIEW_TRAITS_MODE.Summary && state.traitSummary}
			<div class="token-preview-traits-output mono" role="region" aria-label="Token traits">
				{state.traitSummary}
			</div>
		{:else if state.traitDisplay.mode === TOKEN_PREVIEW_TRAITS_MODE.Page && rows.length > 0}
			<dl class="token-preview-traits-output mono" aria-label="Token traits">
				{#each rows as trait}
					{@const href = traitHref(trait)}
					<div class="token-preview-trait-row">
						<dt>
							{clipTokenPreviewTraitText(trait.key, TOKEN_PREVIEW_TRAITS_LIMITS.KeyCharacters)}
						</dt>
						<dd>
							{#if href}
								<a href={href} aria-label={`${trait.key}: ${trait.value}`} onclick={onTraitClick}>
									{clipTokenPreviewTraitText(trait.value, TOKEN_PREVIEW_TRAITS_LIMITS.ValueCharacters)}
								</a>
							{:else}
								{clipTokenPreviewTraitText(trait.value, TOKEN_PREVIEW_TRAITS_LIMITS.ValueCharacters)}
							{/if}
						</dd>
					</div>
				{/each}
			</dl>
		{/if}
	{/if}
	<button
		type="button"
		class="token-preview-media-mode-button"
		class:token-preview-media-mode-button-hovered={hovered}
		disabled={state.status !== TOKEN_PREVIEW_STATUS.Ready}
		{onpointerenter}
		{onpointerleave}
		onclick={onCycle}
	>
		traits
	</button>
</div>
