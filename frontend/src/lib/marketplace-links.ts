import {
	buildBlockExplorerAddressUrl,
	buildBlockExplorerBlockUrl,
	buildBlockExplorerTransactionUrl,
	getDefaultBlockExplorerConfig,
	type BlockExplorerConfig
} from '@artgod/shared/config/block-explorer';
import { normalizeEvmTokenId } from '@artgod/shared/evm/token-id';

/** Read an address/token-ID path pair without trusting a site's hostname or chain label. */
export function parseNftUrl(value: string): { contractAddress: string; tokenId: string } | null {
	const text = value.trim();
	let path = text.split(/[?#]/, 1)[0];
	if (/^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(text)) {
		try {
			path = new URL(text.startsWith('//') ? `https:${text}` : text).pathname;
		} catch {
			return null;
		}
	}
	const match = /(?:^|\/)(0x[\da-f]{40})\/(\d+)(?=\/|$)/i.exec(path);
	if (!match) return null;
	const tokenId = normalizeEvmTokenId(match[2]);
	return tokenId === null ? null : { contractAddress: match[1].toLowerCase(), tokenId };
}

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
