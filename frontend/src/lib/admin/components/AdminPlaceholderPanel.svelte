<script lang="ts">
	type AdminPlaceholderMetric = {
		label: string;
		value: string;
	};

	let {
		eyebrow,
		title,
		description,
		metrics = [],
		notes = []
	}: {
		eyebrow: string;
		title: string;
		description: string;
		metrics?: AdminPlaceholderMetric[];
		notes?: string[];
	} = $props();
</script>

<section class="admin-placeholder-panel">
	<header class="admin-placeholder-header">
		<p class="admin-placeholder-eyebrow">{eyebrow}</p>
		<h2>{title}</h2>
		<p>{description}</p>
	</header>

	{#if metrics.length > 0}
		<div class="admin-placeholder-metrics" aria-label={`${title} overview`}>
			{#each metrics as metric}
				<div class="admin-placeholder-metric">
					<span class="admin-placeholder-metric-label">{metric.label}</span>
					<span class="admin-placeholder-metric-value">{metric.value}</span>
				</div>
			{/each}
		</div>
	{/if}

	{#if notes.length > 0}
		<ul class="admin-placeholder-notes">
			{#each notes as note}
				<li>{note}</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.admin-placeholder-panel {
		border: 1px solid rgba(113, 141, 188, 0.45);
		background: rgba(17, 16, 15, 0.82);
		padding: 1.2rem;
		box-shadow: 0 18px 48px rgba(0, 0, 0, 0.2);
	}

	.admin-placeholder-header h2 {
		margin: 0;
		font-size: 1rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--c-yellow);
	}

	.admin-placeholder-header p:last-child {
		margin: 0.7rem 0 0;
		color: var(--c-sand);
		font-size: 0.86rem;
		line-height: 1.55;
	}

	.admin-placeholder-eyebrow {
		margin: 0 0 0.45rem;
		font-size: 0.68rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--c-cyan);
	}

	.admin-placeholder-metrics {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
		gap: 0.75rem;
		margin-top: 1rem;
	}

	.admin-placeholder-metric {
		border: 1px solid rgba(147, 209, 222, 0.2);
		padding: 0.7rem 0.75rem;
		background: rgba(41, 39, 38, 0.64);
	}

	.admin-placeholder-metric-label {
		display: block;
		font-size: 0.68rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--c-blue);
	}

	.admin-placeholder-metric-value {
		display: block;
		margin-top: 0.35rem;
		font-size: 0.88rem;
		color: var(--c-ice);
	}

	.admin-placeholder-notes {
		margin: 1rem 0 0;
		padding-left: 1rem;
		display: grid;
		gap: 0.55rem;
		font-size: 0.82rem;
		line-height: 1.55;
		color: var(--c-sand);
	}
</style>
