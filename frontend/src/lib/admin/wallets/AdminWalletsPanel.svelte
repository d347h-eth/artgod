<script lang="ts">
	import { onMount } from 'svelte';
	import AdminPlaceholderPanel from '$lib/admin/components/AdminPlaceholderPanel.svelte';
	import { createPlaceholderAdminWalletPort } from '$lib/admin/wallets/adapters/placeholder-admin-wallet-port';
	import type { AdminWalletOverview } from '$lib/admin/wallets/ports';

	const walletPort = createPlaceholderAdminWalletPort();

	let overview = $state<AdminWalletOverview | null>(null);

	onMount(() => {
		void walletPort.getOverview().then((nextOverview) => {
			overview = nextOverview;
		});
	});

	const metrics = $derived.by(() => [
		{
			label: 'configured wallets',
			value: String(overview?.configuredWalletCount ?? 0)
		},
		{
			label: 'custody boundary',
			value: overview?.custodyBoundary === 'native_prompt' ? 'native prompt' : 'pending'
		},
		{
			label: 'planned actions',
			value: overview?.supportedActions.join(' / ') ?? 'import / export / remove'
		}
	]);

	const notes = [
		'Raw private keys will never be entered into the WebView.',
		'Wallet metadata, addresses, and labels will appear here once Rust keystore commands exist.',
		'Import, export, and remove stay blocked in Slice 0 by design.'
	];
</script>

<AdminPlaceholderPanel
	eyebrow="wallets"
	title="Wallet custody surface"
	description="This panel reserves the admin area for Rust-owned wallet metadata and native secret prompts without mixing that flow into the runtime console."
	{metrics}
	{notes}
/>
