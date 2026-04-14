<script lang="ts">
	let { children }: { children: import('svelte').Snippet } = $props();
</script>

<section class="admin-section-frame">
	<div class="admin-section-body">
		{@render children()}
	</div>
</section>

<style>
	.admin-section-frame {
		border: 1px solid rgba(113, 141, 188, 0.45);
		background: rgba(17, 16, 15, 0.82);
		padding: 1.2rem;
		box-shadow: 0 18px 48px rgba(0, 0, 0, 0.2);
		height: 100%;
		min-width: 0;
		min-height: 0;
		max-width: 100%;
		overflow-x: hidden;
	}

	.admin-section-body {
		height: 100%;
		min-width: 0;
		min-height: 0;
		max-width: 100%;
		overflow-x: hidden;
		overflow-y: auto;
		display: grid;
		gap: 1rem;
	}
</style>
