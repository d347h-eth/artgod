<script lang="ts">
	import {
		TERRAFORMS_BEACON_EVENT_TYPES,
		TERRAFORMS_BEACON_EVENT_TYPE_LABELS
	} from '@artgod/shared/extensions/terraforms';
	import { etherscanAddressHref } from '$lib/marketplace-links';
	import type { ActivityExtensionCellProps } from '$lib/activity-extension-views/types';

	let { activity }: ActivityExtensionCellProps = $props();

	function plainDetailsLabel(): string | null {
		switch (eventType()) {
			case TERRAFORMS_BEACON_EVENT_TYPES.BroadcastOrderModified:
				return orderLabel();
			case TERRAFORMS_BEACON_EVENT_TYPES.ScriptComponentModified:
				return joinParts([componentLabel(), indexLabel()]);
			default:
				return null;
		}
	}

	function eventType(): string | null {
		const value = activity.payload?.eventType;
		return typeof value === 'string' ? value : null;
	}

	function satellite(): string | null {
		const value = activity.payload?.satellite;
		return typeof value === 'string' && value.trim() ? value : null;
	}

	function durationLabel(): string | null {
		const value = activity.payload?.duration;
		return typeof value === 'string' && value.trim() ? `duration ${value}` : null;
	}

	function orderLabel(): string | null {
		const value = activity.payload?.order;
		if (!Array.isArray(value)) return null;
		const order = value.map((item) => (typeof item === 'string' ? item : null));
		if (order.some((item) => item === null)) return null;
		return `order ${(order as string[]).join(', ')}`;
	}

	function componentLabel(): string | null {
		const value = activity.payload?.componentLabel;
		return typeof value === 'string' && value.trim() ? value : null;
	}

	function indexLabel(): string | null {
		const value = activity.payload?.index;
		return typeof value === 'string' && value.trim() ? `#${value}` : null;
	}

	function compactAddress(address: string): string {
		if (address.length <= 10) return address;
		return `${address.slice(0, 6)}...${address.slice(-4)}`;
	}

	function fullTitle(): string | undefined {
		const type = eventType();
		if (!type) return undefined;
		const typeLabel = TERRAFORMS_BEACON_EVENT_TYPE_LABELS[type] ?? type;
		const address = satellite();
		return address ? `${typeLabel} ${address}` : typeLabel;
	}

	function joinParts(parts: (string | null)[]): string | null {
		const filtered = parts.filter((part): part is string => Boolean(part));
		return filtered.length > 0 ? filtered.join(' / ') : null;
	}
</script>

{#if satellite()}
	<span title={fullTitle()}>
		satellite
		<a href={etherscanAddressHref(satellite()) ?? '#'} target="_blank" rel="noreferrer noopener">
			{compactAddress(satellite() ?? '')}
		</a>
		{#if durationLabel()}
			/ {durationLabel()}
		{/if}
	</span>
{:else if plainDetailsLabel()}
	<span title={fullTitle()}>{plainDetailsLabel()}</span>
{/if}
