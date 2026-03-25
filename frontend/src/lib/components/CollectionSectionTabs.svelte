<script lang="ts">
	let {
		tokensHref,
		activitiesHref,
		holdersHref,
		customizationHref,
		active,
		showCustomization = true
	}: {
		tokensHref: string;
		activitiesHref: string;
		holdersHref: string;
		customizationHref: string;
		active: 'tokens' | 'activities' | 'holders' | 'customization' | null;
		showCustomization?: boolean;
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
</div>
