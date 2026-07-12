import { resolveOwnerAddressRef } from '$lib/components/owner-ref';
import type { CollectionMediaPreferenceInput } from '$lib/media-mode';
import { joinPath } from '$lib/route-paths';
import { buildOwnerTokensHref, buildTokenDetailHref } from '$lib/token-browser-query';

type ResolveCollectionJumpHrefInput = {
	fetchFn: typeof fetch;
	chainRef: string;
	basePath: string;
	mediaMode: string | null;
	mediaPreference?: CollectionMediaPreferenceInput;
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
			mediaMode: input.mediaMode,
			mediaPreference: input.mediaPreference
		});
	}
	const ownerAddress = await resolveOwnerAddressRef(input);
	return ownerAddress
		? buildOwnerHref(input.basePath, input.mediaMode, input.mediaPreference ?? null, ownerAddress)
		: null;
}

function buildOwnerHref(
	basePath: string,
	mediaMode: string | null,
	mediaPreference: CollectionMediaPreferenceInput,
	ownerRef: string
): string {
	return buildOwnerTokensHref({
		basePath: joinPath(basePath, `holders/${encodeURIComponent(ownerRef)}`),
		selectedTraits: [],
		selectedTraitRanges: [],
		mediaMode,
		mediaPreference
	});
}
