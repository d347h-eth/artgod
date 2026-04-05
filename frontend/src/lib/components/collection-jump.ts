import { isAddressRef, isEnsNameRef } from '@artgod/shared/utils/ref-resolver';
import { resolveOwnerRef } from '$lib/backend-api';
import { joinPath } from '$lib/route-paths';
import { buildOwnerTokensHref, buildTokenDetailHref } from '$lib/token-browser-query';

type ResolveCollectionJumpHrefInput = {
	fetchFn: typeof fetch;
	chainRef: string;
	basePath: string;
	mediaMode: string | null;
	value: string;
};

export async function resolveCollectionJumpHref(
	input: ResolveCollectionJumpHrefInput
): Promise<string | null> {
	const nextValue = input.value.trim();
	if (!nextValue) {
		return null;
	}
	if (/^\d+$/.test(nextValue)) {
		return buildTokenDetailHref({
			basePath: input.basePath,
			tokenId: nextValue,
			mediaMode: input.mediaMode
		});
	}
	if (isAddressRef(nextValue)) {
		return buildOwnerHref(input.basePath, input.mediaMode, nextValue);
	}
	if (!isEnsNameRef(nextValue)) {
		return null;
	}
	if (!input.chainRef.trim()) {
		return null;
	}

	const resolution = await resolveOwnerRef(input.fetchFn, input.chainRef, nextValue);
	return buildOwnerHref(input.basePath, input.mediaMode, resolution.resolvedAddress);
}

function buildOwnerHref(basePath: string, mediaMode: string | null, ownerRef: string): string {
	return buildOwnerTokensHref({
		basePath: joinPath(basePath, `holders/${encodeURIComponent(ownerRef)}`),
		selectedTraits: [],
		selectedTraitRanges: [],
		mediaMode
	});
}
