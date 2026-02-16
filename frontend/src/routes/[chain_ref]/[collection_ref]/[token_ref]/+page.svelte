<script lang="ts">
	import { page } from '$app/state';
</script>

<section class="panel">
	<nav class="breadcrumbs" aria-label="Breadcrumb">
		<a href="/">home</a>
		<span class="breadcrumbs-separator">/</span>
		<a href={`/${page.params.chain_ref}`}>collections</a>
		<span class="breadcrumbs-separator">/</span>
		<a href={`/${page.params.chain_ref}/${page.params.collection_ref}`}>{page.params.collection_ref}</a>
		<span class="breadcrumbs-separator">/</span>
		<span class="breadcrumbs-current">{page.params.token_ref}</span>
	</nav>

	<header class="panel-header">
		<div>
			<h1 class="panel-title">Token Detail</h1>
			<p class="panel-subtitle">token {page.params.token_ref}</p>
		</div>
	</header>

	<footer class="panel-footer">
		<span class="muted">token detail view is scaffolded; richer data follows in next milestones</span>
	</footer>
</section>
