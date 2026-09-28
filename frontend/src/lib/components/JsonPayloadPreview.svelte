<script lang="ts">
	import { onMount } from 'svelte';
	import {
		buildJsonPreviewDocument,
		JSON_PREVIEW_THEME_PROPERTIES,
		type JsonPreviewTheme
	} from '$lib/json-preview';
	import TokenMediaFrame from '$lib/components/TokenMediaFrame.svelte';

	let { text, title = 'tokenURI response' }: { text: string; title?: string } = $props();
	let theme = $state<JsonPreviewTheme | null>(null);
	let previewDocument = $derived(theme ? buildJsonPreviewDocument(text, theme) : null);
	onMount(() => {
		const styles = getComputedStyle(document.documentElement);
		theme = Object.fromEntries(
			JSON_PREVIEW_THEME_PROPERTIES.map((key) => [key, styles.getPropertyValue(key).trim()])
		) as JsonPreviewTheme;
	});
</script>

{#if previewDocument !== null}
	<TokenMediaFrame
		iframeSource={{ kind: 'srcdoc', value: previewDocument }}
		{title}
		className="json-payload-frame"
		allowScripts={false}
	/>
{/if}
