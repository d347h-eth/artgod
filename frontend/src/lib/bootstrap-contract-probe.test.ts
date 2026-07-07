import { describe, expect, it } from 'vitest';
import { BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION } from '@artgod/shared/config/bootstrap';
import { BOOTSTRAP_ENUMERATION_MODE } from '@artgod/shared/bootstrap/pipeline';
import { IMAGE_CACHE_MODE } from '@artgod/shared/media/token-image-cache';
import { COLLECTION_CUSTOMIZATION_SOURCE_KIND } from '@artgod/shared/types';
import {
	BOOTSTRAP_PROBE_STATUS_LABEL,
	bootstrapProbeFormPatch,
	bootstrapProbeNeedsManualScope,
	bootstrapProbeStatusLabel,
	contractNameToBootstrapSlug,
	formatByteSize,
	isBootstrapProbeableAddress,
	normalizeBootstrapAddress
} from './bootstrap-contract-probe';
import type { BootstrapContractProbeApiResponse } from './api-types';

describe('bootstrap contract probe helpers', () => {
	it('normalizes and validates contract addresses', () => {
		expect(isBootstrapProbeableAddress('0x1111111111111111111111111111111111111111')).toBe(true);
		expect(isBootstrapProbeableAddress('0x111')).toBe(false);
		expect(normalizeBootstrapAddress(' 0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD ')).toBe(
			'0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
		);
	});

	it('maps enumerable probes onto the enumerable checkbox', () => {
		expect(bootstrapProbeFormPatch(makeProbe({ enumerable: true }))).toEqual({
			supportsEnumerable: true,
			manualMode: null,
			manualRangeStartTokenId: '',
			manualRangeTotalSupply: ''
		});
	});

	it('maps inferred non-enumerable ranges onto manual range fields', () => {
		expect(
			bootstrapProbeFormPatch(
				makeProbe({
					enumerable: false,
					startTokenId: '1',
					totalSupply: 999
				})
			)
		).toEqual({
			supportsEnumerable: false,
			manualMode: BOOTSTRAP_ENUMERATION_MODE.ManualRange,
			manualRangeStartTokenId: '1',
			manualRangeTotalSupply: '999'
		});
	});

	it('maps shared-contract probes onto manual scope fields', () => {
		const probe = makeProbe({
			enumerable: false,
			startTokenId: '0'
		});
		expect(bootstrapProbeFormPatch(probe)).toEqual({
			supportsEnumerable: false,
			manualMode: null,
			manualRangeStartTokenId: '0',
			manualRangeTotalSupply: ''
		});
		expect(bootstrapProbeStatusLabel(probe)).toBe(BOOTSTRAP_PROBE_STATUS_LABEL.NeedsManualScope);
		expect(bootstrapProbeNeedsManualScope(probe)).toBe(true);
	});

	it('pre-fills known supply when only the token start is missing', () => {
		const probe = makeProbe({
			enumerable: false,
			totalSupply: 940
		});
		expect(bootstrapProbeFormPatch(probe)).toEqual({
			supportsEnumerable: false,
			manualMode: null,
			manualRangeStartTokenId: '',
			manualRangeTotalSupply: '940'
		});
		expect(bootstrapProbeStatusLabel(probe)).toBe(BOOTSTRAP_PROBE_STATUS_LABEL.NeedsTokenStart);
	});

	it('requires manual scope when available supply cannot be used as a bootstrap range', () => {
		const probe = makeProbe({
			enumerable: false,
			startTokenId: '1',
			totalSupply: 1_000_001,
			bootstrapRangeValue: null
		});
		expect(bootstrapProbeFormPatch(probe)).toEqual({
			supportsEnumerable: false,
			manualMode: null,
			manualRangeStartTokenId: '1',
			manualRangeTotalSupply: ''
		});
		expect(bootstrapProbeStatusLabel(probe)).toBe(BOOTSTRAP_PROBE_STATUS_LABEL.NeedsManualScope);
		expect(bootstrapProbeNeedsManualScope(probe)).toBe(true);
	});

	it('labels enumerable and inferred-range probes', () => {
		expect(bootstrapProbeStatusLabel(makeProbe({ enumerable: true, totalSupply: 940 }))).toBe(
			BOOTSTRAP_PROBE_STATUS_LABEL.Enumerable
		);
		expect(
			bootstrapProbeStatusLabel(
				makeProbe({
					enumerable: false,
					startTokenId: '1',
					totalSupply: 940
				})
			)
		).toBe(BOOTSTRAP_PROBE_STATUS_LABEL.RangeInferred);
	});

	it('formats byte counts for tokenURI payload estimates', () => {
		expect(formatByteSize(512)).toBe('512 B');
		expect(formatByteSize(1536)).toBe('1.50 KB');
		expect(formatByteSize('10485760')).toBe('10.0 MB');
	});

	it('normalizes ERC721 names into editable bootstrap slug suggestions', () => {
		expect(contractNameToBootstrapSlug('  Milady by Remilia Corporation!!!  ')).toBe(
			'milady-by-remilia-corporation'
		);
		expect(contractNameToBootstrapSlug('Æther / Test: 2026')).toBe('ther-test-2026');
		expect(contractNameToBootstrapSlug(`${'A'.repeat(70)}!`)).toBe('a'.repeat(64));
	});
});

function makeProbe(input: {
	enumerable: boolean;
	startTokenId?: string;
	totalSupply?: number;
	bootstrapRangeValue?: number | null;
}): BootstrapContractProbeApiResponse {
	const bootstrapRangeValue =
		input.bootstrapRangeValue === undefined
			? (input.totalSupply ?? null)
			: input.bootstrapRangeValue;
	const manualInput =
		input.enumerable || !input.startTokenId || !bootstrapRangeValue
			? null
			: {
					mode: BOOTSTRAP_ENUMERATION_MODE.ManualRange,
					startTokenId: input.startTokenId,
					totalSupply: bootstrapRangeValue
				};
	return {
		chain: {
			id: 1,
			type: 'evm',
			publicChainId: 1,
			slug: 'ethereum',
			name: 'Ethereum'
		},
		address: '0x1111111111111111111111111111111111111111',
		standard: 'erc721',
		proxy: null,
		contractName: null,
		erc721: {
			supported: true,
			error: null
		},
		enumerable: {
			supported: input.enumerable,
			error: null
		},
		totalSupply: {
			status: input.totalSupply ? 'available' : 'unavailable',
			value: input.totalSupply ? String(input.totalSupply) : null,
			safeIntegerValue: input.totalSupply ?? null,
			bootstrapRangeValue,
			error: null
		},
		firstToken: {
			tokenId: input.startTokenId ?? null,
			source: input.enumerable ? 'token_by_index' : 'candidate_token_uri',
			tokenUri: null,
			tokenUriPayloadBytes: null,
			tokenUriPayloadTruncated: false,
			tokenUriPayloadError: null,
			name: null,
			imageSourceField: null,
			image: null,
			imageBytes: null,
			imageBytesSource: null,
			imageContentType: null,
			imageBytesError: null,
			imageWidth: null,
			imageHeight: null,
			animationSourceField: null,
			animationUrl: null,
			metadataError: null,
			candidates: []
		},
		storageEstimate: null,
		imageStorageEstimate: null,
		suggestedInput: {
			supportsEnumerable: input.enumerable,
			manualInput,
			ready: input.enumerable || manualInput !== null,
			warnings: []
		},
		imageCacheSuggestion: {
			selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.User,
			extensionKey: null,
			config: {
				imageCacheMode: IMAGE_CACHE_MODE.CacheOnce,
				maxDimension: BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION
			}
		}
	};
}
