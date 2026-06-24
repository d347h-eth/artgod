import { TRADING_BIDDING_BID_BOOK_PRICE_KIND } from '@artgod/shared/types';
import type { ApiBiddingBidBookRow } from '$lib/api-types';

export type BidBookUpdateFlashKey = string | number | null | undefined;
export const BID_BOOK_UPDATE_FLASH_MODE = {
	Persistent: 'persistent',
	Transient: 'transient'
} as const;

type BidBookUpdateFlashMode =
	(typeof BID_BOOK_UPDATE_FLASH_MODE)[keyof typeof BID_BOOK_UPDATE_FLASH_MODE];

type BidBookUpdateFlashOptions = {
	key: BidBookUpdateFlashKey;
	mode?: BidBookUpdateFlashMode;
	playOnMount?: boolean;
};

export type BidBookUpdateFlashInput =
	| BidBookUpdateFlashKey
	| BidBookUpdateFlashOptions
	| null
	| undefined;

const BID_BOOK_UPDATE_FLASH_KEY_SEPARATOR = '\u0000';
const BID_BOOK_UPDATE_FLASH_TIMING = {
	[BID_BOOK_UPDATE_FLASH_MODE.Persistent]: {
		duration: 540,
		easing: 'cubic-bezier(0.16, 1, 0.3, 1)'
	},
	[BID_BOOK_UPDATE_FLASH_MODE.Transient]: {
		duration: 760,
		easing: 'cubic-bezier(0.16, 1, 0.3, 1)'
	}
} as const;
const BID_BOOK_UPDATE_FLASH_KEYFRAMES = {
	[BID_BOOK_UPDATE_FLASH_MODE.Persistent]: [
		{ backgroundColor: 'var(--bid-book-update-flash-peak-background)', offset: 0 },
		{ backgroundColor: 'var(--bid-book-update-flash-peak-background)', offset: 0.12 },
		{ backgroundColor: 'var(--bid-book-own-row-background)', offset: 1 }
	],
	[BID_BOOK_UPDATE_FLASH_MODE.Transient]: [
		{ backgroundColor: 'transparent', offset: 0 },
		{ backgroundColor: 'var(--bid-book-update-flash-peak-background)', offset: 0.08 },
		{ backgroundColor: 'var(--bid-book-own-row-background)', offset: 0.45 },
		{ backgroundColor: 'transparent', offset: 1 }
	]
} as const satisfies Record<BidBookUpdateFlashMode, Keyframe[]>;

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
		bid.price.kind === TRADING_BIDDING_BID_BOOK_PRICE_KIND.Exact
			? ''
			: bid.price.ceilingWei,
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

type NormalizedBidBookUpdateFlashOptions = Required<BidBookUpdateFlashOptions>;

const EMPTY_BID_BOOK_UPDATE_FLASH_OPTIONS: NormalizedBidBookUpdateFlashOptions = {
	key: null,
	mode: BID_BOOK_UPDATE_FLASH_MODE.Persistent,
	playOnMount: false
};

function normalizeBidBookUpdateFlashInput(
	input: BidBookUpdateFlashInput
): NormalizedBidBookUpdateFlashOptions {
	if (input && typeof input === 'object' && 'key' in input) {
		return {
			key: input.key,
			mode: input.mode ?? BID_BOOK_UPDATE_FLASH_MODE.Persistent,
			playOnMount: input.playOnMount ?? false
		};
	}
	return {
		...EMPTY_BID_BOOK_UPDATE_FLASH_OPTIONS,
		key: input
	};
}

function bidBookUpdateFlashKeyChanged(
	left: NormalizedBidBookUpdateFlashOptions,
	right: NormalizedBidBookUpdateFlashOptions
): boolean {
	return left.key !== right.key || left.mode !== right.mode;
}

function bidBookUpdateFlashTiming(mode: BidBookUpdateFlashMode): KeyframeAnimationOptions {
	return {
		...BID_BOOK_UPDATE_FLASH_TIMING[mode],
		fill: 'none'
	};
}

function bidBookUpdateFlashKeyframes(mode: BidBookUpdateFlashMode): Keyframe[] {
	return [...BID_BOOK_UPDATE_FLASH_KEYFRAMES[mode]];
}

// Replays the bid-book update flash when the supplied refresh key changes.
export function bidBookUpdateFlash(node: HTMLElement, input: BidBookUpdateFlashInput) {
	let current = normalizeBidBookUpdateFlashInput(input);
	let animation: Animation | null = null;

	function replay(options: NormalizedBidBookUpdateFlashOptions): void {
		if (options.key === null || options.key === undefined || typeof node.animate !== 'function') {
			return;
		}
		animation?.cancel();
		animation = node.animate(
			bidBookUpdateFlashKeyframes(options.mode),
			bidBookUpdateFlashTiming(options.mode)
		);
	}

	if (current.playOnMount) {
		replay(current);
	}

	return {
		update(nextInput: BidBookUpdateFlashInput) {
			const next = normalizeBidBookUpdateFlashInput(nextInput);
			if (!bidBookUpdateFlashKeyChanged(current, next)) {
				current = next;
				return;
			}
			current = next;
			replay(next);
		},
		destroy() {
			animation?.cancel();
		}
	};
}
