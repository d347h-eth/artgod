export { bootstrapSampleOwnership, bootstrapSampleFailure } from '@artgod/shared/bootstrap/probe';
import { BOOTSTRAP_COLLECTION_SLUG_MAX_LENGTH } from '@artgod/shared/config/bootstrap';
import type {
	BootstrapContractFindings,
	BootstrapProjectScopeSuggestion
} from '@artgod/shared/bootstrap/probe';
import { bootstrapTokenDiscovery } from '@artgod/shared/bootstrap/sample-selection';

/** Contract-wide facts must not become one shared project's range suggestions. */
export function bootstrapRangeSuggestions(
	contract: BootstrapContractFindings | null,
	project: BootstrapProjectScopeSuggestion | null
) {
	const projectStartConfirmed = Boolean(
		project?.startTokenOwnership?.exists === true &&
		project.startTokenOwnership.tokenId === project.startTokenId
	);
	const conventionalStart =
		contract && !contract.sharedContract
			? bootstrapTokenDiscovery(contract.discovery.enumeration, contract.discovery.candidates)
					.rangeStartCandidate
			: null;
	const startTokenId = project
		? projectStartConfirmed
			? project.startTokenId
			: null
		: conventionalStart;
	return {
		startTokenId,
		// A current absence of 0 cannot prove it was never part of this range.
		startTokenIdConfirmed: project ? projectStartConfirmed : startTokenId === '0',
		tokenCount:
			project?.mintedTokenCount ??
			(contract?.sharedContract ? null : contract?.totalSupply.bootstrapRangeValue) ??
			null,
		maxTokenCount:
			project && project.maxTokenCount !== project.mintedTokenCount ? project.maxTokenCount : null
	};
}

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

function parseByteString(value: string): bigint | null {
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	return BigInt(trimmed);
}
