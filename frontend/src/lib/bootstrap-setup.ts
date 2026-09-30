import {
	BOOTSTRAP_COLLECTION_SLUG_MAX_LENGTH,
	BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION,
	BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION
} from '@artgod/shared/config/bootstrap';
import type { BootstrapEnumerationMode } from '@artgod/shared/bootstrap/pipeline';
import { IMAGE_CACHE_MODE, type ImageCacheMode } from '@artgod/shared/media/token-image-cache';
import { isBootstrapProbeableAddress } from './bootstrap-contract-probe';
import {
	BootstrapScopeValidationError,
	BOOTSTRAP_SCOPE_FIELD,
	parseBootstrapScope,
	bootstrapScopeContainsToken,
	type BootstrapScope
} from '@artgod/shared/bootstrap/scope';

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

export function bootstrapSetupScope(draft: BootstrapSetupDraft): BootstrapScope {
	return parseBootstrapScope({
		mode: draft.scopeMode,
		startTokenId: draft.startTokenId,
		tokenCount: /^\d+$/.test(draft.totalSupply.trim()) ? Number(draft.totalSupply) : NaN,
		tokenIds: bootstrapTokenIds(draft.tokenIds)
	});
}

export function bootstrapSetupIssues(draft: BootstrapSetupDraft) {
	const issues: Partial<Record<keyof BootstrapSetupDraft, string>> = {};
	if (!isBootstrapProbeableAddress(draft.address)) {
		issues.address =
			'Enter a contract address (0x + 40 hex characters), or paste an NFT URL containing <contract address>/<decimal token ID>.';
	}
	const slug = draft.slug.trim().toLowerCase();
	if (!slug) issues.slug = 'Enter a collection slug, or apply the probe suggestion.';
	else if (!/^[a-z0-9-]+$/.test(slug) || slug.length > BOOTSTRAP_COLLECTION_SLUG_MAX_LENGTH) {
		issues.slug = `Use letters, numbers and hyphens, up to ${BOOTSTRAP_COLLECTION_SLUG_MAX_LENGTH} characters.`;
	}
	if (!draft.imageSourceField.trim()) {
		issues.imageSourceField = 'Enter an image source field, or apply the probe suggestion.';
	}
	try {
		bootstrapSetupScope(draft);
	} catch (error) {
		if (!(error instanceof BootstrapScopeValidationError)) throw error;
		for (const [key, message] of Object.entries(error.issues)) {
			const field =
				key === BOOTSTRAP_SCOPE_FIELD.TokenCount
					? 'totalSupply'
					: key === BOOTSTRAP_SCOPE_FIELD.Mode
						? 'scopeMode'
						: (key as 'startTokenId' | 'tokenIds');
			issues[field] = message;
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
	try {
		return bootstrapScopeContainsToken(bootstrapSetupScope(draft), sample);
	} catch (error) {
		if (!(error instanceof BootstrapScopeValidationError)) throw error;
		return false;
	}
}
