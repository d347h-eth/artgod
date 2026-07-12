<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolveCollectionJumpHref } from '$lib/components/collection-jump';
	import type { CollectionMediaPreferenceInput } from '$lib/media-mode';

	let {
		chainRef,
		basePath,
		mediaMode,
		mediaPreference = null
	}: {
		chainRef: string;
		basePath: string;
		mediaMode: string | null;
		mediaPreference?: CollectionMediaPreferenceInput;
	} = $props();

	let value = $state('');

	async function onSubmit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const href = await resolveCollectionJumpHref({
			fetchFn: fetch,
			chainRef,
			basePath,
			mediaMode,
			mediaPreference,
			value
		}).catch(() => null);
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
		placeholder="jump to token #/owner/.eth"
		aria-label="Jump to token, owner, or ENS name"
		autocomplete="off"
		autocapitalize="off"
		enterkeyhint="go"
		spellcheck="false"
	/>
</form>
