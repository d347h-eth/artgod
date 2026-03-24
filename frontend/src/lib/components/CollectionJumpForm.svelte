<script lang="ts">
	import { goto } from '$app/navigation';
	import { buildOwnerTokensHref, buildTokenDetailHref } from '$lib/token-browser-query';

	let {
		basePath,
		mediaMode
	}: {
		basePath: string;
		mediaMode: string | null;
	} = $props();

	let value = $state('');

	function normalizedValue(): string {
		return value.trim();
	}

	function resolveJumpHref(): string | null {
		const nextValue = normalizedValue();
		if (/^\d+$/.test(nextValue)) {
			return buildTokenDetailHref({
				basePath,
				tokenId: nextValue,
				mediaMode
			});
		}
		if (/^0x[a-fA-F0-9]{40}$/.test(nextValue)) {
			return buildOwnerTokensHref({
				basePath: `${basePath}/holders/${encodeURIComponent(nextValue)}`,
				selectedTraits: [],
				selectedTraitRanges: [],
				mediaMode
			});
		}
		return null;
	}

	async function onSubmit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const href = resolveJumpHref();
		if (!href) return;
		value = '';
		await goto(href);
	}
</script>

<form class="collection-jump-form" onsubmit={onSubmit}>
	<input
		class="collection-jump-input"
		type="text"
		bind:value
		placeholder="jump to token #/owner"
		aria-label="Jump to token or owner"
		autocomplete="off"
		autocapitalize="off"
		spellcheck="false"
	/>
</form>
