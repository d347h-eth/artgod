<script lang="ts">
	import AdminRuntimePanel from '$lib/admin/runtime/AdminRuntimePanel.svelte';
	import AdminBotsPanel from '$lib/admin/bots/AdminBotsPanel.svelte';
	import AdminWalletsPanel from '$lib/admin/wallets/AdminWalletsPanel.svelte';
</script>

<svelte:head>
	<title>ArtGod Admin</title>
</svelte:head>

<main class="admin-shell">
	<div class="admin-shell-frame">
		<header class="admin-shell-header">
			<div class="admin-shell-copy">
				<p class="admin-shell-eyebrow">desktop admin shell</p>
				<h1>Local runtime and wallet operations</h1>
				<p class="admin-shell-description">
					Runtime controls stay in the WebView. Wallet custody and future bot unlock flows are
					reserved here, but remain non-functional until the Rust keystore slices land.
				</p>
			</div>
		</header>

		<div class="admin-shell-grid">
			<div class="admin-shell-runtime">
				<AdminRuntimePanel />
			</div>

			<div class="admin-shell-sidebar">
				<AdminWalletsPanel />
				<AdminBotsPanel />
			</div>
		</div>
	</div>
</main>

<style>
	.admin-shell {
		min-height: 100vh;
		padding: 1.5rem;
		background:
			radial-gradient(circle at top left, rgba(147, 209, 222, 0.14), transparent 34%),
			linear-gradient(180deg, rgba(17, 16, 15, 0.98), rgba(41, 39, 38, 0.98));
	}

	.admin-shell-frame {
		max-width: 88rem;
		margin: 0 auto;
		display: grid;
		gap: 1.5rem;
	}

	.admin-shell-header {
		border: 1px solid rgba(113, 141, 188, 0.45);
		background: rgba(17, 16, 15, 0.76);
		padding: 1.25rem 1.4rem;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.28);
	}

	.admin-shell-copy {
		max-width: 42rem;
	}

	.admin-shell-eyebrow {
		margin: 0 0 0.55rem;
		font-size: 0.72rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--c-cyan);
	}

	.admin-shell-header h1 {
		margin: 0;
		font-size: clamp(1.5rem, 2vw, 2.1rem);
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--c-yellow);
	}

	.admin-shell-description {
		margin: 0.8rem 0 0;
		max-width: 40rem;
		font-size: 0.9rem;
		line-height: 1.6;
		color: var(--c-sand);
	}

	.admin-shell-grid {
		display: grid;
		grid-template-columns: minmax(0, 1.45fr) minmax(20rem, 0.8fr);
		gap: 1.5rem;
		align-items: start;
	}

	.admin-shell-sidebar {
		display: grid;
		gap: 1.5rem;
	}

	@media (max-width: 70rem) {
		.admin-shell-grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	@media (max-width: 40rem) {
		.admin-shell {
			padding: 1rem;
		}

		.admin-shell-header {
			padding: 1rem;
		}
	}
</style>
