<script lang="ts">
	let {
		tokensHref,
		activitiesHref,
		holdersHref,
		customizationHref,
		biddingHref,
		active,
		showCustomization = true,
		showBidding = true
	}: {
		tokensHref: string;
		activitiesHref: string;
		holdersHref: string;
		customizationHref: string;
		biddingHref: string;
		active: 'tokens' | 'activities' | 'holders' | 'customization' | 'bidding' | null;
		showCustomization?: boolean;
		showBidding?: boolean;
	} = $props();
</script>

<div class="runtime-tabs" aria-label="Collection sections">
	{#if active === 'tokens'}
		<span class="runtime-tab-active">tokens</span>
	{:else}
		<a href={tokensHref}>tokens</a>
	{/if}
	{#if active === 'activities'}
		<span class="runtime-tab-active">activities</span>
	{:else}
		<a href={activitiesHref}>activities</a>
	{/if}
	{#if active === 'holders'}
		<span class="runtime-tab-active">holders</span>
	{:else}
		<a href={holdersHref}>holders</a>
	{/if}
	{#if showCustomization}
		{#if active === 'customization'}
			<span class="runtime-tab-active">customization</span>
		{:else}
			<a href={customizationHref}>customization</a>
		{/if}
	{/if}
	{#if showBidding}
		{#if active === 'bidding'}
			<span class="runtime-tab-active">bidding</span>
		{:else}
			<a href={biddingHref}>bidding</a>
		{/if}
	{/if}
</div>
