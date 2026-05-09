<script lang="ts">
	import {
		TERRAFORMS_EXTENSION_EVENT_KEYS,
		TERRAFORMS_EXTENSION_KEY
	} from '@artgod/shared/extensions/terraforms';
	import { TERRAFORMS_TOKEN_DETAIL_SECTION_LABELS } from '$lib/activity-extension-views/terraforms/constants';
	import FilterIcon from '$lib/components/FilterIcon.svelte';
	import type { TokenDetailExtensionSectionProps } from '$lib/token-detail-extension-sections/types';

	let { token, hrefs }: TokenDetailExtensionSectionProps = $props();

	let dreamsHref = $derived(
		hrefs.activityExtensionEvent(
			{
				extensionKey: TERRAFORMS_EXTENSION_KEY,
				eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Terraformed
			},
			{ tokenId: token.tokenId }
		)
	);
</script>

<div class="terraforms-token-dreams-section">
	<span class="muted terraforms-token-dreams-label">
		{TERRAFORMS_TOKEN_DETAIL_SECTION_LABELS.Dreams}:
	</span>
	<a class="terraforms-token-dreams-link" href={dreamsHref}>
		<FilterIcon />
		<span>{TERRAFORMS_TOKEN_DETAIL_SECTION_LABELS.FilterByToken}</span>
	</a>
</div>

<style>
	.terraforms-token-dreams-section {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		font-size: 0.78rem;
	}

	.terraforms-token-dreams-label {
		margin: 0;
	}

	.terraforms-token-dreams-link {
		display: inline-flex;
		align-items: center;
		gap: 0.28rem;
		white-space: nowrap;
	}
</style>
