<script lang="ts">
	import {
		VIEW_OFFER_APPLICABILITY,
		type ViewOfferApplicability
	} from '@artgod/shared/types/trait-catalog';

	let { applicability }: { applicability?: ViewOfferApplicability } = $props();
</script>

{#if applicability === VIEW_OFFER_APPLICABILITY.Unresolved}
	<div class="muted">View match unknown</div>
{/if}
