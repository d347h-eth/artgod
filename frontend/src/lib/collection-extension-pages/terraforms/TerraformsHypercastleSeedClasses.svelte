<script lang="ts">
	import {
		buildTerraformsHypercastleTokenHref,
		buildTerraformsSeedClassTokenHref,
		formatTerraformsHypercastleTokenLabel,
		TERRAFORMS_HYPERCASTLE_GODMODE_TOKENS,
		TERRAFORMS_HYPERCASTLE_RENDERER_BUCKET_ROWS,
		TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM,
		TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS,
		TERRAFORMS_HYPERCASTLE_SEED_CLASS_ROWS
	} from '$lib/collection-extension-pages/terraforms/hypercastle-seed-classes';

	let { basePath, mediaMode }: { basePath: string; mediaMode: string | null } = $props();

	function seedClassHref(seedClass: string): string {
		return buildTerraformsSeedClassTokenHref({
			basePath,
			mediaMode,
			seedClass
		});
	}

	function tokenHref(tokenId: string): string {
		return buildTerraformsHypercastleTokenHref(basePath, tokenId);
	}
</script>

<article
	class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.root}
	data-testid={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.testIds.root}
>
	<section class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.section}>
		<h2 class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.heading}>
			{TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.Heading}
		</h2>
		<h3 class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.subheading}>
			{TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.SeedTraitsHeading}
		</h3>
		<p class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.copy}>
			{TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.SeedTraitCopy}
		</p>
	</section>

	<section class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.section}>
		<h3 class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.subheading}>
			{TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.SeedClassesHeading}
		</h3>
		<table
			class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.table}
			data-testid={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.testIds.seedClassTable}
		>
			<thead>
				<tr>
					<th>{TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.ClassColumn}</th>
					<th>{TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.ConditionColumn}</th>
					<th>{TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.RuntimeColumn}</th>
				</tr>
			</thead>
			<tbody>
				{#each TERRAFORMS_HYPERCASTLE_SEED_CLASS_ROWS as row (row.key)}
					<tr>
						<td>
							{#if row.traitValue}
								<a
									class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.tableLink}
									href={seedClassHref(row.traitValue)}
								>
									{row.label}
								</a>
							{:else}
								{row.label}
							{/if}
						</td>
						<td>{row.condition}</td>
						<td>{row.runtime}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>

	<section class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.section}>
		<h3 class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.subheading}>
			{TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.RendererBucketsHeading}
		</h3>
		<p class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.copy}>
			{TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.RendererCopy}
		</p>
		<table
			class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.table}
			data-testid={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.testIds.rendererBucketTable}
		>
			<thead>
				<tr>
					<th>{TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.ClassColumn}</th>
					<th>{TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.ConditionColumn}</th>
					<th>{TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.RuntimeColumn}</th>
					<th>{TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.SeedClassColumn}</th>
				</tr>
			</thead>
			<tbody>
				{#each TERRAFORMS_HYPERCASTLE_RENDERER_BUCKET_ROWS as row (row.key)}
					<tr>
						<td>{row.label}</td>
						<td>{row.condition}</td>
						<td>{row.runtime}</td>
						<td>{row.seedClass}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>

	<section class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.section}>
		<h3 class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.subheading}>
			{TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.GodmodeHeading}
		</h3>
		<p class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.copy}>
			{TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.GodmodeCopy}
		</p>
		<table class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.table}>
			<thead>
				<tr>
					<th>{TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.TokenColumn}</th>
					<th>{TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.ModeColumn}</th>
					<th>{TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.SeedColumn}</th>
				</tr>
			</thead>
			<tbody>
				{#each TERRAFORMS_HYPERCASTLE_GODMODE_TOKENS as token (token.tokenId)}
					<tr>
						<td class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.numericCell}>
							<a
								class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.tableLink}
								href={tokenHref(token.tokenId)}
							>
								{formatTerraformsHypercastleTokenLabel(token.tokenId)}
							</a>
						</td>
						<td>{token.mode}</td>
						<td class={TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM.classes.numericCell}>
							{token.seed}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>
</article>

<style>
	.terraforms-hypercastle-seed-classes {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		row-gap: 1.1rem;
		max-width: min(100%, 1120px);
	}

	.terraforms-hypercastle-seed-classes-section {
		min-width: 0;
	}

	.terraforms-hypercastle-seed-classes-heading {
		margin: 0 0 0.55rem;
		font-size: 1rem;
		font-weight: 600;
		color: var(--c-ice);
		letter-spacing: 0;
	}

	.terraforms-hypercastle-seed-classes-subheading {
		margin: 0 0 0.4rem;
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--c-pink);
		text-transform: uppercase;
		letter-spacing: 0;
	}

	.terraforms-hypercastle-seed-classes-copy {
		max-width: 72rem;
		margin: 0;
		font-size: 0.82rem;
		line-height: 1.45;
	}

	.terraforms-hypercastle-seed-classes-table {
		width: auto;
		max-width: 100%;
		border-collapse: collapse;
		font-size: 0.78rem;
	}

	.terraforms-hypercastle-seed-classes-table th,
	.terraforms-hypercastle-seed-classes-table td {
		padding: 0.42rem 0.55rem;
		border-bottom: 1px solid var(--c-blue);
		text-align: left;
		vertical-align: top;
	}

	.terraforms-hypercastle-seed-classes-table th {
		color: var(--c-orange);
		font-weight: 600;
	}

	.terraforms-hypercastle-seed-classes-table-link {
		color: var(--c-cyan);
		text-decoration: underline;
		text-decoration-thickness: 1px;
		text-underline-offset: 2px;
	}

	.terraforms-hypercastle-seed-classes-table-link:hover,
	.terraforms-hypercastle-seed-classes-table-link:focus-visible {
		color: var(--c-yellow);
	}

	.terraforms-hypercastle-seed-classes-numeric-cell {
		font-family: var(--font-mono);
		white-space: nowrap;
	}

	@media (max-width: 980px) {
		.terraforms-hypercastle-seed-classes-table {
			width: 100%;
			font-size: 0.72rem;
		}

		.terraforms-hypercastle-seed-classes-table th,
		.terraforms-hypercastle-seed-classes-table td {
			padding: 0.38rem 0.35rem;
		}
	}
</style>
