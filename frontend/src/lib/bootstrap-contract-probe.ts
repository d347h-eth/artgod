import type { BootstrapContractProbeApiResponse } from '$lib/api-types';

export type BootstrapContractProbeFormPatch = {
	supportsEnumerable: boolean;
	manualMode: 'manual_range' | null;
	manualRangeStartTokenId: string;
	manualRangeTotalSupply: string;
};

const BOOTSTRAP_COLLECTION_SLUG_MAX_LENGTH = 64;

export function isBootstrapProbeableAddress(value: string): boolean {
	return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
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

export function bootstrapProbeFormPatch(
	probe: BootstrapContractProbeApiResponse
): BootstrapContractProbeFormPatch {
	if (probe.suggestedInput.supportsEnumerable) {
		return {
			supportsEnumerable: true,
			manualMode: null,
			manualRangeStartTokenId: '',
			manualRangeTotalSupply: ''
		};
	}

	const manualInput = probe.suggestedInput.manualInput;
	return {
		supportsEnumerable: false,
		manualMode: manualInput?.mode === 'manual_range' ? 'manual_range' : null,
		manualRangeStartTokenId: manualInput?.startTokenId ?? '',
		manualRangeTotalSupply:
			manualInput && Number.isFinite(manualInput.totalSupply)
				? String(manualInput.totalSupply)
				: ''
	};
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
	if (probe.enumerable.supported === true) return 'enumerable';
	if (probe.suggestedInput.manualInput) return 'range inferred';
	if (probe.totalSupply.status === 'available') return 'needs token start';
	return 'needs manual scope';
}

function parseByteString(value: string): bigint | null {
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	return BigInt(trimmed);
}
