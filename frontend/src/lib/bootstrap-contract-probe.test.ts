import { describe, expect, it } from 'vitest';
import {
	bootstrapProbeFormPatch,
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
			manualMode: 'manual_range',
			manualRangeStartTokenId: '1',
			manualRangeTotalSupply: '999'
		});
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
}): BootstrapContractProbeApiResponse {
	const manualInput =
		input.enumerable || !input.startTokenId || !input.totalSupply
			? null
			: {
					mode: 'manual_range' as const,
					startTokenId: input.startTokenId,
					totalSupply: input.totalSupply
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
			bootstrapRangeValue: input.totalSupply ?? null,
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
			image: null,
			imageBytes: null,
			imageBytesSource: null,
			imageContentType: null,
			imageBytesError: null,
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
		}
	};
}
