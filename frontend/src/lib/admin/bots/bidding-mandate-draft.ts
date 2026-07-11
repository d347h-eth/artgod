import type {
	AdminBiddingCollectionCandidate,
	AdminBiddingMandateDraft,
	AdminBiddingTokenScopeSummary
} from '$lib/admin/bots/ports';

const POSITIVE_ETH_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/;
const ZERO_ETH_PATTERN = /^0(?:\.0{1,18})?$/;

export type BiddingCollectionMandateSelection = {
	selected: boolean;
	maxUnitBidEth: string;
	maxQuantity: string;
};

export type BiddingMandateSelections = Record<string, BiddingCollectionMandateSelection>;

// Keeps operator-entered caps while refreshing canonical collection identity from Rust.
export function syncBiddingMandateSelections(
	candidates: AdminBiddingCollectionCandidate[],
	current: BiddingMandateSelections
): BiddingMandateSelections {
	return Object.fromEntries(
		candidates.map((candidate) => {
			const key = String(candidate.collectionId);
			return [
				key,
				current[key] ?? {
					selected: false,
					maxUnitBidEth: '',
					maxQuantity: '1'
				}
			];
		})
	);
}

// Builds the untrusted proposal that Rust re-resolves before native authorization.
export function buildBiddingMandateDraft(
	candidates: AdminBiddingCollectionCandidate[],
	selections: BiddingMandateSelections
): AdminBiddingMandateDraft {
	const collections = candidates.flatMap((candidate) => {
		const selection = selections[String(candidate.collectionId)];
		if (!selection?.selected) return [];
		const maxUnitBidEth = selection.maxUnitBidEth.trim();
		if (!POSITIVE_ETH_PATTERN.test(maxUnitBidEth) || ZERO_ETH_PATTERN.test(maxUnitBidEth)) {
			throw new Error(
				`${candidate.artgodSlug}: max WETH per NFT must be positive with at most 18 decimals.`
			);
		}
		const maxQuantity = Number(selection.maxQuantity);
		if (!Number.isSafeInteger(maxQuantity) || maxQuantity <= 0) {
			throw new Error(`${candidate.artgodSlug}: max NFTs per offer must be a positive integer.`);
		}
		return [{ collectionId: candidate.collectionId, maxUnitBidEth, maxQuantity }];
	});
	if (collections.length === 0) {
		throw new Error('Select at least one collection for the native bidding mandate.');
	}
	return { collections };
}

export function isBiddingMandateDraftReady(
	candidates: AdminBiddingCollectionCandidate[],
	selections: BiddingMandateSelections
): boolean {
	try {
		buildBiddingMandateDraft(candidates, selections);
		return true;
	} catch {
		return false;
	}
}

// Formats canonical token-scope identity without repeating equivalent summary fields.
export function formatBiddingMandateTokenScope(scope: AdminBiddingTokenScopeSummary): string {
	const normalizedLabel = scope.label.trim().toLowerCase();
	const details = scope.items
		.filter((item) => item.value.trim().toLowerCase() !== normalizedLabel)
		.map((item) => `${item.label}: ${item.value}`);
	return [scope.label, ...details].join(' · ');
}

// Formats native-returned wei caps for the compact active-mandate read model.
export function formatBiddingMandateWeiAsEth(wei: string): string {
	if (!/^[0-9]+$/.test(wei)) return `${wei} wei`;
	const padded = wei.padStart(19, '0');
	const whole = padded.slice(0, -18).replace(/^0+(?=[0-9])/, '');
	const fraction = padded.slice(-18).replace(/0+$/, '');
	return fraction ? `${whole}.${fraction} WETH` : `${whole} WETH`;
}
