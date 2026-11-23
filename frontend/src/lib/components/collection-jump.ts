import { type CatalogScope } from '$lib/collection-view';
import { resolveOwnerAddressRef } from '$lib/components/owner-ref';
import type { CollectionMediaPreferenceInput } from '$lib/media-mode';
import { joinPath } from '$lib/route-paths';
import { buildOwnerTokensHref, buildTokenDetailHref } from '$lib/token-browser-query';

type ResolveCollectionJumpHrefInput = {
	fetchFn: typeof fetch;
	chainRef: string;
	basePath: string;
	catalogScope?: CatalogScope | null;
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
			catalogScope: input.catalogScope,
			mediaMode: input.mediaMode,
			mediaPreference: input.mediaPreference
		});
	}
	const ownerAddress = await resolveOwnerAddressRef(input);
	return ownerAddress
		? buildOwnerHref(
				input.basePath,
				input.mediaMode,
				input.mediaPreference ?? null,
				ownerAddress,
				input.catalogScope
			)
		: null;
}

function buildOwnerHref(
	basePath: string,
	mediaMode: string | null,
	mediaPreference: CollectionMediaPreferenceInput,
	ownerRef: string,
	catalogScope?: CatalogScope | null
): string {
	return buildOwnerTokensHref({
		basePath: joinPath(basePath, `holders/${encodeURIComponent(ownerRef)}`),
		catalogScope,
		selectedTraits: [],
		selectedTraitRanges: [],
		mediaMode,
		mediaPreference
	});
}
