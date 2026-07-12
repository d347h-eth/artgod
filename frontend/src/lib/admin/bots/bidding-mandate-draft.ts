import type {
	AdminBiddingChainIdentity,
	AdminBiddingCollectionCandidate,
	AdminBiddingMandateDraft,
	AdminBiddingTokenScopeSummary
} from '$lib/admin/bots/ports';

const POSITIVE_ETH_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/;
const ZERO_ETH_PATTERN = /^0(?:\.0{1,18})?$/;

export type BiddingCollectionMandateSelection = {
	selected: boolean;
	maxUnitBidEth: string;
	maxUnitBidEthEdited: boolean;
};

export type BiddingMandateSelections = Record<string, BiddingCollectionMandateSelection>;

// Shows enabled-job price maxima first without moving rows while the operator edits them.
export function sortBiddingCollectionCandidatesByMaxUnitBid(
	candidates: AdminBiddingCollectionCandidate[]
): AdminBiddingCollectionCandidate[] {
	return [...candidates].sort((left, right) => {
		const priceOrder = compareOptionalCanonicalEthDescending(
			left.jobCeilingPrefillEth,
			right.jobCeilingPrefillEth
		);
		if (priceOrder !== 0) return priceOrder;
		if (left.artgodSlug !== right.artgodSlug) {
			return left.artgodSlug < right.artgodSlug ? -1 : 1;
		}
		if (left.collectionId === right.collectionId) return 0;
		return left.collectionId < right.collectionId ? -1 : 1;
	});
}

// Formats a named chain first while keeping its external numeric identity explicit.
export function formatBiddingChainIdentity(
	chain: AdminBiddingChainIdentity,
	activeChainId = chain.chainId
): string {
	if (chain.chainId !== activeChainId) {
		return `chain ID #${activeChainId}`;
	}
	return `${chain.name} · chain ID #${activeChainId}`;
}

// Keeps operator-entered caps while refreshing canonical collection identity from Rust.
export function syncBiddingMandateSelections(
	candidates: AdminBiddingCollectionCandidate[],
	current: BiddingMandateSelections
): BiddingMandateSelections {
	return Object.fromEntries(
		candidates.map((candidate) => {
			const key = String(candidate.collectionId);
			const existing = current[key];
			if (existing && (existing.selected || existing.maxUnitBidEthEdited)) {
				return [key, existing];
			}
			return [
				key,
				{
					selected: false,
					maxUnitBidEth: candidate.jobCeilingPrefillEth ?? '',
					maxUnitBidEthEdited: false
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
		return [{ collectionId: candidate.collectionId, maxUnitBidEth }];
	});
	if (collections.length === 0) {
		throw new Error('Select at least one collection to authorize bidding.');
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

function compareOptionalCanonicalEthDescending(left: string | null, right: string | null): number {
	if (left === null) return right === null ? 0 : 1;
	if (right === null) return -1;
	const [leftWhole, leftFraction = ''] = left.split('.');
	const [rightWhole, rightFraction = ''] = right.split('.');
	if (leftWhole.length !== rightWhole.length) {
		return rightWhole.length - leftWhole.length;
	}
	if (leftWhole !== rightWhole) return leftWhole < rightWhole ? 1 : -1;
	const fractionLength = Math.max(leftFraction.length, rightFraction.length);
	const paddedLeftFraction = leftFraction.padEnd(fractionLength, '0');
	const paddedRightFraction = rightFraction.padEnd(fractionLength, '0');
	if (paddedLeftFraction === paddedRightFraction) return 0;
	return paddedLeftFraction < paddedRightFraction ? 1 : -1;
}
