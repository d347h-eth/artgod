import {
	buildBlockExplorerAddressUrl,
	buildBlockExplorerBlockUrl,
	buildBlockExplorerTransactionUrl,
	getDefaultBlockExplorerConfig,
	type BlockExplorerConfig
} from '@artgod/shared/config/block-explorer';

export function openseaItemHref(params: {
	chainSlug: string | null;
	collectionAddress: string | null;
	tokenId: string | null;
}): string | null {
	if (!params.chainSlug || !params.collectionAddress || !params.tokenId) {
		return null;
	}
	return `https://opensea.io/item/${params.chainSlug}/${params.collectionAddress}/${encodeURIComponent(params.tokenId)}`;
}

export function blockExplorerTransactionHref(
	txHash: string | null,
	config: BlockExplorerConfig = getDefaultBlockExplorerConfig()
): string | null {
	try {
		return buildBlockExplorerTransactionUrl({ txHash, config });
	} catch {
		return null;
	}
}

export function blockExplorerAddressHref(
	address: string | null,
	config: BlockExplorerConfig = getDefaultBlockExplorerConfig()
): string | null {
	try {
		return buildBlockExplorerAddressUrl({ address, config });
	} catch {
		return null;
	}
}

export function blockExplorerBlockHref(
	blockNumber: number | string | null,
	config: BlockExplorerConfig = getDefaultBlockExplorerConfig()
): string | null {
	try {
		return buildBlockExplorerBlockUrl({ blockNumber, config });
	} catch {
		return null;
	}
}
