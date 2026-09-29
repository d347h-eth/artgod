import { describe, expect, it } from 'vitest';
import { BOOTSTRAP_COLLECTION_SLUG_MAX_LENGTH } from '@artgod/shared/config/bootstrap';
import {
	bootstrapTestSample,
	bootstrapTestContract,
	BOOTSTRAP_TEST_PROJECT_SCOPE
} from '@artgod/shared/testing/bootstrap-probe';
import { BOOTSTRAP_SHARED_CONTRACT_REASON } from '@artgod/shared/bootstrap/probe';
import {
	bootstrapSampleOwnership,
	bootstrapSampleFailure,
	bootstrapRangeSuggestions,
	contractNameToBootstrapSlug,
	formatByteSize,
	isBootstrapProbeableAddress,
	normalizeBootstrapAddress
} from './bootstrap-contract-probe';
describe('bootstrap display helpers', () => {
	it('prefers project scope and separates partial-mint choices, suppressing shared contract-wide guesses', () => {
		const contract = bootstrapTestContract();
		expect(bootstrapRangeSuggestions(contract, null)).toEqual({
			startTokenId: '0',
			startTokenIdConfirmed: true,
			tokenCount: 100,
			maxTokenCount: null
		});
		contract.sharedContract = {
			reason: BOOTSTRAP_SHARED_CONTRACT_REASON.Registry,
			registryAddress: null
		};
		expect(bootstrapRangeSuggestions(contract, null)).toEqual({
			startTokenId: null,
			startTokenIdConfirmed: false,
			tokenCount: null,
			maxTokenCount: null
		});
		expect(bootstrapRangeSuggestions(contract, BOOTSTRAP_TEST_PROJECT_SCOPE)).toEqual({
			startTokenId: '163000000',
			startTokenIdConfirmed: true,
			tokenCount: 1000,
			maxTokenCount: null
		});
		expect(
			bootstrapRangeSuggestions(null, { ...BOOTSTRAP_TEST_PROJECT_SCOPE, mintedTokenCount: 486 })
		).toEqual({
			startTokenId: '163000000',
			startTokenIdConfirmed: true,
			tokenCount: 486,
			maxTokenCount: 1000
		});
	});
	it.each([false, null])(
		'keeps project counts while withholding an unconfirmed start (%s)',
		(exists) => {
			const project = {
				...BOOTSTRAP_TEST_PROJECT_SCOPE,
				startTokenOwnership: {
					tokenId: BOOTSTRAP_TEST_PROJECT_SCOPE.startTokenId,
					exists,
					error: 'ownership failed'
				}
			};
			expect(bootstrapRangeSuggestions(bootstrapTestContract(), project)).toEqual({
				startTokenId: null,
				startTokenIdConfirmed: false,
				tokenCount: 1000,
				maxTokenCount: null
			});
		}
	);
	it('does not accept ownership evidence for another project token', () => {
		expect(
			bootstrapRangeSuggestions(null, {
				...BOOTSTRAP_TEST_PROJECT_SCOPE,
				startTokenOwnership: { tokenId: '163000485', exists: true, error: null }
			})
		).toMatchObject({ startTokenId: null, startTokenIdConfirmed: false });
	});
	it.each([false, null])(
		'keeps a conventional 1 suggestion under review or withholds it when 0 ownership is %s',
		(zero) => {
			const contract = bootstrapTestContract();
			contract.discovery = {
				enumeration: { checked: false, tokenId: null, error: null },
				candidates: [
					{ tokenId: '0', exists: zero, error: null },
					{ tokenId: '1', exists: true, error: null }
				],
				rangeStartCandidate: '1',
				sampleTokenId: '1'
			};
			expect(bootstrapRangeSuggestions(contract, null)).toMatchObject({
				startTokenId: zero === false ? '1' : null,
				startTokenIdConfirmed: false
			});
		}
	);
	it('requires review when no contract or project evidence is available', () => {
		expect(bootstrapRangeSuggestions(null, null)).toEqual({
			startTokenId: null,
			startTokenIdConfirmed: false,
			tokenCount: null,
			maxTokenCount: null
		});
	});
	it('normalizes addresses', () => {
		expect(isBootstrapProbeableAddress('0x' + 'a'.repeat(40))).toBe(true);
		expect(isBootstrapProbeableAddress('0x1')).toBe(false);
		expect(isBootstrapProbeableAddress('0x' + 'g'.repeat(40))).toBe(false);
		expect(normalizeBootstrapAddress(' 0xAB ')).toBe('0xab');
	});
	it.each([
		[null, '-'],
		[undefined, '-'],
		['bad', '-'],
		['12', '12 B'],
		[1536, '1.50 KB'],
		['10485760', '10.0 MB'],
		[102400, '100 KB']
	])('formats %s', (value, result) => {
		expect(formatByteSize(value)).toBe(result);
	});
	it('keeps ownership separate from each metadata failure', () => {
		const sample = bootstrapTestSample().sample;
		for (const field of ['tokenUriError', 'tokenUriPayloadError', 'metadataError'] as const) {
			sample[field] = 'HTTP 429';
			expect(bootstrapSampleFailure(sample)).toBe('HTTP 429');
			expect(bootstrapSampleOwnership(sample)).toBe(true);
			sample[field] = null;
		}
		expect(bootstrapSampleFailure(sample)).toBeNull();
		sample.ownership = { tokenId: '0', exists: false, error: 'No owner' };
		expect(bootstrapSampleOwnership(sample)).toBe(false);
		expect(bootstrapSampleFailure(sample)).toBe('No owner');
		sample.ownership = null;
		expect(bootstrapSampleOwnership(sample)).toBeNull();
		expect(bootstrapSampleFailure(sample)).toContain('Ownership could not');
		sample.tokenId = null;
		expect(bootstrapSampleFailure(sample)).toContain('No sample was confirmed');
	});
	it('normalizes ERC721 names into editable bootstrap slug suggestions', () => {
		expect(contractNameToBootstrapSlug(null)).toBe('');
		expect(contractNameToBootstrapSlug('  Milady by Remilia Corporation!!!  ')).toBe(
			'milady-by-remilia-corporation'
		);
		expect(contractNameToBootstrapSlug('Æther / Test: 2026')).toBe('ther-test-2026');
		expect(
			contractNameToBootstrapSlug(`${'A'.repeat(BOOTSTRAP_COLLECTION_SLUG_MAX_LENGTH + 10)}!`)
		).toBe('a'.repeat(BOOTSTRAP_COLLECTION_SLUG_MAX_LENGTH));
	});
});
