import { describe, expect, it } from 'vitest';
import { BOOTSTRAP_ENUMERATION_MODE } from '@artgod/shared/bootstrap/pipeline';
import {
	BOOTSTRAP_MANUAL_RANGE_TOTAL_SUPPLY_LIMIT,
	BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION
} from '@artgod/shared/config/bootstrap';
import { IMAGE_CACHE_MODE } from '@artgod/shared/media/token-image-cache';
import {
	bootstrapSampleMatchesScope,
	bootstrapSetupIssues,
	type BootstrapSetupDraft
} from './bootstrap-setup';

const draft: BootstrapSetupDraft = {
	address: '0xc374a204334d4edd4c6a62f0867c752d65e9579c',
	slug: 'project-aeon',
	imageSourceField: 'image',
	scopeMode: BOOTSTRAP_ENUMERATION_MODE.ManualRange,
	startTokenId: '1',
	totalSupply: '3333',
	tokenIds: '',
	imageCacheMode: IMAGE_CACHE_MODE.CacheOnce,
	maxDimension: '1080'
};

describe('bootstrap setup', () => {
	it('accepts a declared target without sample, probe, metadata or estimate evidence', () => {
		expect(bootstrapSetupIssues(draft)).toEqual({});
		expect(
			bootstrapSetupIssues({
				...draft,
				scopeMode: BOOTSTRAP_ENUMERATION_MODE.Enumerable,
				startTokenId: '',
				totalSupply: ''
			})
		).toEqual({});
	});
	it('keeps required fields and scope limits enforceable without network checks', () => {
		expect(
			bootstrapSetupIssues({
				...draft,
				address: 'bad',
				slug: 'bad slug',
				imageSourceField: '',
				startTokenId: '-1',
				totalSupply: String(BOOTSTRAP_MANUAL_RANGE_TOTAL_SUPPLY_LIMIT + 1)
			})
		).toEqual({
			address: expect.any(String),
			slug: expect.any(String),
			imageSourceField: expect.any(String),
			startTokenId: expect.any(String),
			totalSupply: expect.any(String)
		});
	});
	it('validates explicit scope instead of depending on a preview sample', () => {
		const explicit = {
			...draft,
			scopeMode: BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds,
			tokenIds: '1, 3 1000'
		};
		expect(bootstrapSetupIssues(explicit)).toEqual({});
		expect(bootstrapSampleMatchesScope('2', explicit)).toBe(false);
		expect(bootstrapSampleMatchesScope('0003', explicit)).toBe(true);
		expect(bootstrapSetupIssues({ ...explicit, tokenIds: '1, invalid' }).tokenIds).toBeDefined();
	});
	it('separates out-of-scope marketplace evidence from valid bootstrap admission', () => {
		expect(bootstrapSampleMatchesScope('0', draft)).toBe(false);
		expect(bootstrapSampleMatchesScope('3333', draft)).toBe(true);
		expect(bootstrapSampleMatchesScope('3334', draft)).toBe(false);
		expect(bootstrapSetupIssues(draft)).toEqual({});
	});
	it('allows original dimensions and validates enabled cache settings without an estimate', () => {
		expect(bootstrapSetupIssues({ ...draft, maxDimension: '' })).toEqual({});
		expect(
			bootstrapSetupIssues({
				...draft,
				maxDimension: String(BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION - 1)
			}).maxDimension
		).toBeDefined();
		expect(
			bootstrapSetupIssues({ ...draft, imageCacheMode: IMAGE_CACHE_MODE.Off, maxDimension: 'bad' })
		).toEqual({});
	});

	it('keeps incomplete and malformed scopes local to the required fields', () => {
		expect(bootstrapSetupIssues({ ...draft, slug: '' }).slug).toBeDefined();
		expect(
			bootstrapSetupIssues({ ...draft, scopeMode: 'invalid' as BootstrapSetupDraft['scopeMode'] })
				.scopeMode
		).toBeDefined();
		expect(bootstrapSampleMatchesScope('1', { ...draft, totalSupply: '' })).toBe(false);
		expect(bootstrapSampleMatchesScope('invalid', draft)).toBe(false);
	});

	it('does not turn unexpected failures into ordinary invalid-scope feedback', () => {
		const broken = Object.defineProperty({ ...draft }, 'totalSupply', {
			get() {
				throw new Error('unexpected draft failure');
			}
		});
		expect(() => bootstrapSetupIssues(broken)).toThrow('unexpected draft failure');
		expect(() => bootstrapSampleMatchesScope('1', broken)).toThrow('unexpected draft failure');
	});
});
