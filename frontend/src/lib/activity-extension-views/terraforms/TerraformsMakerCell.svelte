<script lang="ts">
	import type { ActivityExtensionCellProps } from '$lib/activity-extension-views/types';

	let { activity, hrefs }: ActivityExtensionCellProps = $props();

	function makerAddress(): string | null {
		return activity.maker ?? activity.from;
	}

	function compactAddress(address: string): string {
		if (address.length <= 10) return address;
		return `${address.slice(0, 6)}...${address.slice(-4)}`;
	}
</script>

{#if makerAddress()}
	<a href={hrefs.filter({ maker: makerAddress() })} title={makerAddress() ?? undefined}>
		{compactAddress(makerAddress() ?? '')}
	</a>
{:else}
	<span class="muted">-</span>
{/if}
