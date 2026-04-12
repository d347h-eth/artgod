<script lang="ts">
	import DesktopRuntimeDrawer from '$lib/components/DesktopRuntimeDrawer.svelte';
</script>

<section class="admin-runtime-panel" aria-label="Desktop runtime">
	<header class="admin-runtime-header">
		<p class="admin-runtime-eyebrow">runtime</p>
		<h2>Desktop lifecycle console</h2>
		<p>
			This is the existing Tauri runtime surface. Wallet import/export/unlock and bot startup will
			land beside it, not inside it.
		</p>
	</header>

	<DesktopRuntimeDrawer embedded={true} />
</section>

<style>
	.admin-runtime-panel {
		display: grid;
		gap: 0.9rem;
	}

	.admin-runtime-header {
		border: 1px solid rgba(113, 141, 188, 0.45);
		background: rgba(17, 16, 15, 0.78);
		padding: 1rem 1.15rem;
	}

	.admin-runtime-eyebrow {
		margin: 0 0 0.45rem;
		font-size: 0.68rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--c-cyan);
	}

	.admin-runtime-header h2 {
		margin: 0;
		font-size: 1rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--c-yellow);
	}

	.admin-runtime-header p:last-child {
		margin: 0.65rem 0 0;
		font-size: 0.84rem;
		line-height: 1.55;
		color: var(--c-sand);
	}
</style>
