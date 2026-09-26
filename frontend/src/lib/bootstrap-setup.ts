import {
	BOOTSTRAP_COLLECTION_SLUG_MAX_LENGTH,
	BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION,
	BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION,
	BOOTSTRAP_MANUAL_RANGE_TOTAL_SUPPLY_LIMIT,
	BOOTSTRAP_MANUAL_TOKEN_IDS_LIMIT,
	BOOTSTRAP_TOKEN_ID_MAX_LENGTH
} from '@artgod/shared/config/bootstrap';
import {
	BOOTSTRAP_ENUMERATION_MODE,
	type BootstrapEnumerationMode
} from '@artgod/shared/bootstrap/pipeline';
import { IMAGE_CACHE_MODE, type ImageCacheMode } from '@artgod/shared/media/token-image-cache';
import { isBootstrapProbeableAddress } from './bootstrap-contract-probe';

// Queue eligibility describes the declared target. Optional network evidence never
// participates: the worker checks the chain and records recoverable task failures.
export type BootstrapSetupDraft = {
	address: string;
	slug: string;
	imageSourceField: string;
	scopeMode: BootstrapEnumerationMode;
	startTokenId: string;
	totalSupply: string;
	tokenIds: string;
	imageCacheMode: ImageCacheMode;
	maxDimension: string;
};

export function bootstrapTokenIds(value: string): string[] {
	return value.split(/[\s,]+/).filter(Boolean);
}

function validTokenId(value: string): boolean {
	return /^\d+$/.test(value) && value.length <= BOOTSTRAP_TOKEN_ID_MAX_LENGTH;
}

export function bootstrapSetupIssues(draft: BootstrapSetupDraft) {
	const issues: Partial<Record<keyof BootstrapSetupDraft, string>> = {};
	if (!isBootstrapProbeableAddress(draft.address)) {
		issues.address = 'Enter a contract address: 0x followed by 40 hexadecimal characters.';
	}
	const slug = draft.slug.trim().toLowerCase();
	if (!slug) issues.slug = 'Enter a collection slug, or apply the probe suggestion.';
	else if (!/^[a-z0-9-]+$/.test(slug) || slug.length > BOOTSTRAP_COLLECTION_SLUG_MAX_LENGTH) {
		issues.slug = `Use letters, numbers and hyphens, up to ${BOOTSTRAP_COLLECTION_SLUG_MAX_LENGTH} characters.`;
	}
	if (!draft.imageSourceField.trim()) {
		issues.imageSourceField = 'Enter an image source field, or apply the probe suggestion.';
	}
	if (draft.scopeMode === BOOTSTRAP_ENUMERATION_MODE.ManualRange) {
		if (!validTokenId(draft.startTokenId.trim())) {
			issues.startTokenId = 'Enter the first token ID as a nonnegative decimal integer.';
		}
		const count = Number(draft.totalSupply.trim());
		if (
			!/^\d+$/.test(draft.totalSupply.trim()) ||
			!Number.isSafeInteger(count) ||
			count < 1 ||
			count > BOOTSTRAP_MANUAL_RANGE_TOTAL_SUPPLY_LIMIT
		) {
			issues.totalSupply = `Enter a token count from 1 to ${BOOTSTRAP_MANUAL_RANGE_TOTAL_SUPPLY_LIMIT.toLocaleString('en-US')}.`;
		}
	} else if (draft.scopeMode === BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds) {
		const ids = bootstrapTokenIds(draft.tokenIds);
		if (!ids.length || ids.some((id) => !validTokenId(id))) {
			issues.tokenIds = 'Enter decimal token IDs separated by commas or spaces.';
		} else if (ids.length > BOOTSTRAP_MANUAL_TOKEN_IDS_LIMIT) {
			issues.tokenIds = `Enter at most ${BOOTSTRAP_MANUAL_TOKEN_IDS_LIMIT.toLocaleString('en-US')} token IDs.`;
		}
	}
	const dimension = draft.maxDimension.trim();
	if (
		draft.imageCacheMode !== IMAGE_CACHE_MODE.Off &&
		dimension &&
		(!/^\d+$/.test(dimension) ||
			Number(dimension) < BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION ||
			Number(dimension) > BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION)
	) {
		issues.maxDimension = `Enter ${BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION}–${BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION} pixels, or leave blank for original dimensions.`;
	}
	return issues;
}

// A sample outside the declared scope cannot identify this collection on OpenSea.
// It can still be inspected, and it never invalidates the scope sent to bootstrap.
export function bootstrapSampleMatchesScope(sample: string, draft: BootstrapSetupDraft): boolean {
	if (!validTokenId(sample.trim())) return false;
	if (draft.scopeMode === BOOTSTRAP_ENUMERATION_MODE.Enumerable) return true;
	const value = BigInt(sample.trim());
	if (draft.scopeMode === BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds) {
		return bootstrapTokenIds(draft.tokenIds).some((id) => validTokenId(id) && BigInt(id) === value);
	}
	if (!validTokenId(draft.startTokenId.trim()) || !/^\d+$/.test(draft.totalSupply.trim()))
		return false;
	const start = BigInt(draft.startTokenId.trim());
	return value >= start && value < start + BigInt(draft.totalSupply.trim());
}
