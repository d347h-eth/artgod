import type { BootstrapContractProbeApiResponse } from '$lib/api-types';

const BOOTSTRAP_COLLECTION_SLUG_MAX_LENGTH = 64;

// Editable conventional range start; it does not claim a token is minted.
export const BOOTSTRAP_MANUAL_RANGE_DEFAULT_START_TOKEN_ID = '1';

// Local lifecycle of an explicitly submitted bootstrap probe.
export const BOOTSTRAP_PROBE_UI_STATUS = {
	Idle: 'idle',
	Loading: 'loading',
	Ready: 'ready',
	Error: 'error'
} as const;

// Complete EVM contract-address length required before bootstrap probing starts.
export const BOOTSTRAP_CONTRACT_ADDRESS_LENGTH = 42;

// Safety guidance shown beside the contract address before any bootstrap probe runs.
export const BOOTSTRAP_CONTRACT_ADDRESS_SAFETY_WARNING =
	'Only enter a verified, well-known contract address. Do not probe a contract with private or unverified source code. Confirm the address is authentic before continuing.';

// Explicit user acknowledgment required before the bootstrap probe form is enabled.
export const BOOTSTRAP_CONTRACT_ADDRESS_SAFETY_ACKNOWLEDGEMENT =
	'I have verified the contract address and want to continue.';

// Contract probe status labels drive bootstrap form flow hints.
export const BOOTSTRAP_PROBE_STATUS_LABEL = {
	Enumerable: 'enumerable',
	RangeInferred: 'range inferred',
	NeedsTokenStart: 'needs token start',
	NeedsManualScope: 'needs manual scope'
} as const;

export function isBootstrapAddressComplete(value: string): boolean {
	return value.trim().length === BOOTSTRAP_CONTRACT_ADDRESS_LENGTH;
}

export function isBootstrapProbeableAddress(value: string): boolean {
	return isBootstrapAddressComplete(value) && /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

export function normalizeBootstrapAddress(value: string): string {
	return value.trim().toLowerCase();
}

// Converts ERC721 name() output into the local bootstrap slug suggestion.
export function contractNameToBootstrapSlug(value: string | null | undefined): string {
	if (!value) return '';
	let slug = '';
	for (const char of value.trim().toLowerCase()) {
		if (/^[a-z0-9]$/.test(char)) {
			slug += char;
			continue;
		}
		if (/^[\s!-\/:-@\[-`{-~]$/.test(char)) {
			slug += '-';
		}
	}
	return slug
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, BOOTSTRAP_COLLECTION_SLUG_MAX_LENGTH)
		.replace(/-+$/g, '');
}

export function formatByteSize(value: number | string | null | undefined): string {
	if (value === null || value === undefined) return '-';
	const bytes = typeof value === 'number' ? BigInt(value) : parseByteString(value);
	if (bytes === null) return '-';
	const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
	let unitIndex = 0;
	let scaled = Number(bytes);
	while (scaled >= 1024 && unitIndex < units.length - 1) {
		scaled /= 1024;
		unitIndex += 1;
	}
	const decimals = scaled >= 100 || unitIndex === 0 ? 0 : scaled >= 10 ? 1 : 2;
	return `${scaled.toFixed(decimals)} ${units[unitIndex]}`;
}

export function bootstrapProbeStatusLabel(probe: BootstrapContractProbeApiResponse): string {
	if (probe.suggestedInput.supportsEnumerable) return BOOTSTRAP_PROBE_STATUS_LABEL.Enumerable;
	if (probe.suggestedInput.manualInput) return BOOTSTRAP_PROBE_STATUS_LABEL.RangeInferred;
	if (!probe.firstToken.tokenId && probe.totalSupply.bootstrapRangeValue !== null) {
		return BOOTSTRAP_PROBE_STATUS_LABEL.NeedsTokenStart;
	}
	return BOOTSTRAP_PROBE_STATUS_LABEL.NeedsManualScope;
}

export function bootstrapProbeNeedsManualScope(probe: BootstrapContractProbeApiResponse): boolean {
	return bootstrapProbeStatusLabel(probe) === BOOTSTRAP_PROBE_STATUS_LABEL.NeedsManualScope;
}

function parseByteString(value: string): bigint | null {
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	return BigInt(trimmed);
}
