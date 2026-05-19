import type { ApiBiddingBidBookRow } from '$lib/api-types';
import type { BidBookTraitValueHref } from '$lib/bidding-bid-book-display';

// Names scope-cell presentation variants for the regular bid-book table.
export const BID_BOOK_ROWS_TABLE_SCOPE_KIND = {
	Plain: 'plain',
	PlainAction: 'plain-action',
	Traits: 'traits'
} as const;

// Describes one already-derived regular bid-book row for presentation-only table rendering.
export type BidBookRowsTableRow = {
	bid: ApiBiddingBidBookRow;
	price: string;
	quantityPrefix: string | null;
	makerHref: string;
	makerHighlighted: boolean;
	placedAtLabel: string;
	placedAtTitle: string | undefined;
	validUntilLabel: string;
	validUntilTitle: string | undefined;
	muted: boolean;
	hidden: boolean;
	startsNewBucket: boolean;
	priceActionLabel: string | null;
	scope: BidBookRowsTableScope;
};

// Describes scope-cell content without leaking bid-book table layout back into callers.
export type BidBookRowsTableScope =
	| {
			kind: typeof BID_BOOK_ROWS_TABLE_SCOPE_KIND.Plain;
			label: string;
	  }
	| {
			kind: typeof BID_BOOK_ROWS_TABLE_SCOPE_KIND.PlainAction;
			label: string;
			placeBidLabel: string;
	  }
	| {
			kind: typeof BID_BOOK_ROWS_TABLE_SCOPE_KIND.Traits;
			traits: ApiBiddingBidBookRow['scope']['traits'];
			traitValueHref: BidBookTraitValueHref | null;
			showFilterAction: boolean;
			filterLabel: string;
			placeBidLabel: string | null;
	  };
