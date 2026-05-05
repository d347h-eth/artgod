import { resolveOwnerAddressRef } from '$lib/components/owner-ref';
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
	const ownerAddress = await resolveOwnerAddressRef(input);
	return ownerAddress ? buildOwnerHref(input.basePath, input.mediaMode, ownerAddress) : null;
}

function buildOwnerHref(basePath: string, mediaMode: string | null, ownerRef: string): string {
	return buildOwnerTokensHref({
		basePath: joinPath(basePath, `holders/${encodeURIComponent(ownerRef)}`),
		selectedTraits: [],
		selectedTraitRanges: [],
		mediaMode
	});
}
