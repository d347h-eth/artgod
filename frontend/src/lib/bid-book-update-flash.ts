import { TRADING_BIDDING_BID_BOOK_PRICE_KIND } from '@artgod/shared/types';
import type { ApiBiddingBidBookRow } from '$lib/api-types';

export {
	UPDATE_FLASH_MODE as BID_BOOK_UPDATE_FLASH_MODE,
	updateFlash as bidBookUpdateFlash
} from '$lib/update-flash';
export type {
	UpdateFlashKey as BidBookUpdateFlashKey,
	UpdateFlashInput as BidBookUpdateFlashInput
} from '$lib/update-flash';

const BID_BOOK_UPDATE_FLASH_KEY_SEPARATOR = '\u0000';

// Builds the bid-row flash key from values whose changes should visibly pulse own rows.
export function bidBookOwnRowFlashKey(bid: ApiBiddingBidBookRow): string {
	return [
		bid.orderId,
		bid.source,
		bid.materialization.kind,
		bid.materialization.jobId ?? '',
		bid.materialization.status ?? '',
		bid.materialization.phase ?? '',
		bid.scope.kind,
		bid.scope.tokenId ?? '',
		bid.scope.traits.map((trait) => `${trait.type}=${trait.value}`).join('|'),
		bid.price.kind,
		bid.price.kind === TRADING_BIDDING_BID_BOOK_PRICE_KIND.Exact
			? bid.price.wei
			: bid.price.floorWei,
		bid.price.kind === TRADING_BIDDING_BID_BOOK_PRICE_KIND.Exact ? '' : bid.price.ceilingWei,
		bid.quantity,
		bid.validUntil ?? '',
		bid.placedAt ?? '',
		bid.ownStatus?.position ?? '',
		bid.ownStatus?.constraints.join('|') ?? '',
		bid.ownStatus?.job?.jobId ?? '',
		bid.ownStatus?.job?.revision ?? '',
		bid.ownStatus?.job?.status ?? ''
	].join(BID_BOOK_UPDATE_FLASH_KEY_SEPARATOR);
}
