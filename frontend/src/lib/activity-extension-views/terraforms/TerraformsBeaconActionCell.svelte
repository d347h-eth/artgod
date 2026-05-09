<script lang="ts">
	import type { ActivityExtensionCellProps } from '$lib/activity-extension-views/types';

	let { activity }: ActivityExtensionCellProps = $props();

	function actionLabel(): string | null {
		const modificationLabel = activity.payload?.modificationLabel;
		if (typeof modificationLabel === 'string' && modificationLabel.trim()) {
			return modificationLabel;
		}
		const eventLabel = activity.payload?.eventLabel;
		if (typeof eventLabel === 'string' && eventLabel.trim()) {
			return eventLabel;
		}
		return null;
	}

	function modificationValue(): string | null {
		const value = activity.payload?.modification;
		if (typeof value === 'number' && Number.isInteger(value)) {
			return String(value);
		}
		return null;
	}
</script>

{#if actionLabel()}
	<span title={modificationValue() ? `AntennaModification ${modificationValue()}` : undefined}>
		{actionLabel()}
	</span>
{:else}
	<span class="muted">-</span>
{/if}
