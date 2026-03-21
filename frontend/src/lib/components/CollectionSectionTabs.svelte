<script lang="ts">
	let {
		basePath,
		active
	}: {
		basePath: string;
		active: 'tokens' | 'activities' | 'holders';
	} = $props();

	function activitiesHref(): string {
		return `${basePath}/activity?kind=sales`;
	}

	function holdersHref(): string {
		return `${basePath}/holders`;
	}
</script>

<div class="runtime-tabs" aria-label="Collection sections">
	<a href={basePath} class:runtime-tab-active={active === 'tokens'} aria-current={active === 'tokens' ? 'page' : undefined}>tokens</a>
	<a
		href={activitiesHref()}
		class:runtime-tab-active={active === 'activities'}
		aria-current={active === 'activities' ? 'page' : undefined}>activities</a
	>
	<a
		href={holdersHref()}
		class:runtime-tab-active={active === 'holders'}
		aria-current={active === 'holders' ? 'page' : undefined}>holders</a
	>
</div>
