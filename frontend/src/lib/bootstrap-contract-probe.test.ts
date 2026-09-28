import { describe, expect, it } from 'vitest';
import { BOOTSTRAP_COLLECTION_SLUG_MAX_LENGTH } from '@artgod/shared/config/bootstrap';
import { bootstrapTestSample } from '@artgod/shared/testing/bootstrap-probe';
import {
	bootstrapSampleOwnership,
	bootstrapSampleFailure,
	contractNameToBootstrapSlug,
	formatByteSize,
	isBootstrapProbeableAddress,
	normalizeBootstrapAddress
} from './bootstrap-contract-probe';
describe('bootstrap display helpers', () => {
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
