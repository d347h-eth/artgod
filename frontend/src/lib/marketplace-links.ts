import {
	buildTransactionExplorerUrl,
	getDefaultTransactionExplorerUrlTemplate
} from '@artgod/shared/config/transaction-explorer';

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

export function transactionExplorerHref(
	txHash: string | null,
	urlTemplate = getDefaultTransactionExplorerUrlTemplate()
): string | null {
	try {
		return buildTransactionExplorerUrl({ txHash, urlTemplate });
	} catch {
		return null;
	}
}

export function etherscanAddressHref(address: string | null): string | null {
	if (!address) {
		return null;
	}
	return `https://etherscan.io/address/${encodeURIComponent(address)}`;
}
