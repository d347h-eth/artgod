<script lang="ts">
	import { onMount } from 'svelte';
	import AdminPlaceholderPanel from '$lib/admin/components/AdminPlaceholderPanel.svelte';
	import { createPlaceholderAdminBotPort } from '$lib/admin/bots/adapters/placeholder-admin-bot-port';
	import type { AdminBotOverview } from '$lib/admin/bots/ports';

	const botPort = createPlaceholderAdminBotPort();

	let overview = $state<AdminBotOverview | null>(null);

	onMount(() => {
		void botPort.getOverview().then((nextOverview) => {
			overview = nextOverview;
		});
	});

	const metrics = $derived.by(() => [
		{
			label: 'bot pair',
			value: overview?.configuredBotKinds.join(' / ') ?? 'bidding / sniping'
		},
		{
			label: 'restart policy',
			value: overview?.restartPolicy === 'prompt_on_restart' ? 'restart = prompt' : 'pending'
		},
		{
			label: 'secret handoff',
			value: overview?.secretHandoff === 'stdin_pipe_once' ? 'stdin / pipe once' : 'pending'
		}
	]);

	const notes = [
		'Bot lifecycle controls will stay separate from the indexer composition controls.',
		'Every bot start or restart will require a fresh unlock prompt in later slices.',
		'No bot launch or secret ingestion is implemented in Slice 0.'
	];
</script>

<AdminPlaceholderPanel
	eyebrow="bots"
	title="Trading bot surface"
	description="This panel reserves the future admin controls for bidding and sniping runtimes so their unlock and restart rules stay explicit."
	{metrics}
	{notes}
/>
