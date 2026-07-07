import { get, writable, type Readable } from 'svelte/store';
import {
	DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG,
	type BiddingBidBookLiveRefreshConfig
} from '@artgod/shared/config/bidding';
import type {
	ApiBiddingBidBook,
	ApiChain,
	ApiCollection
} from '$lib/api-types';
import { getTokenBiddingBidBook } from '$lib/backend-api';
import {
	BIDDING_AUTOMATION_DRAFT_TARGET_TYPE,
	biddingAutomationDraftTokenId,
	type BiddingAutomationDraft
} from '$lib/bidding-automation';
import { emptyBiddingBidBook } from '$lib/bidding-empty-state';
import {
	biddingBidBookLivePollIntervalMs,
	startBiddingBidBookLiveRefresh,
	type BiddingBidBookLiveRefreshHandle
} from '$lib/bidding-live-refresh';

export type TokenBiddingPanelBidBookContext = {
	fetchFn: typeof fetch;
	chain: ApiChain | null;
	collection: ApiCollection | null;
	draft: BiddingAutomationDraft | null;
	open: boolean;
};

export type TokenBiddingPanelBidBookState = {
	tokenId: string | null;
	bidBook: ApiBiddingBidBook;
};

export type TokenBiddingPanelBidBookController = {
	state: Readable<TokenBiddingPanelBidBookState>;
	sync(context: TokenBiddingPanelBidBookContext): void;
	refreshNow(context: TokenBiddingPanelBidBookContext): Promise<void>;
	start(
		context: () => TokenBiddingPanelBidBookContext,
		config: () => BiddingBidBookLiveRefreshConfig
	): BiddingBidBookLiveRefreshHandle;
};

// Keeps token-browser bidding panels supplied with the same bid-book state used by token detail.
export function createTokenBiddingPanelBidBookController(): TokenBiddingPanelBidBookController {
	const state = writable<TokenBiddingPanelBidBookState>(emptyTokenBiddingPanelBidBookState());
	let requestId = 0;

	function sync(context: TokenBiddingPanelBidBookContext): void {
		const tokenId = panelBidBookTokenId(context);
		const current = get(state);
		if (!tokenId) {
			requestId += 1;
			if (current.tokenId !== null || current.bidBook.bids.length > 0) {
				state.set(emptyTokenBiddingPanelBidBookState());
			}
			return;
		}
		if (current.tokenId !== tokenId) {
			state.set({ tokenId, bidBook: emptyBiddingBidBook() });
		}
		void refreshNow(context);
	}

	async function refreshNow(context: TokenBiddingPanelBidBookContext): Promise<void> {
		const tokenId = panelBidBookTokenId(context);
		if (!tokenId || !context.chain || !context.collection) {
			return;
		}

		const activeRequestId = requestId + 1;
		requestId = activeRequestId;
		try {
			// Hydrate backend-owned ownStatus for the exact token target currently shown in the panel.
			const response = await getTokenBiddingBidBook(
				context.fetchFn,
				context.chain.slug,
				context.collection.slug,
				tokenId
			);
			if (requestId !== activeRequestId || panelBidBookTokenId(context) !== tokenId) {
				return;
			}
			state.set({ tokenId, bidBook: response.bidBook });
		} catch {
			// Preserve the last coherent panel state after transient backend or network failures.
		}
	}

	function start(
		context: () => TokenBiddingPanelBidBookContext,
		config: () => BiddingBidBookLiveRefreshConfig
	): BiddingBidBookLiveRefreshHandle {
		return startBiddingBidBookLiveRefresh({
			refresh: () => refreshNow(context()),
			intervalMs: () =>
				biddingBidBookLivePollIntervalMs(
					get(state).bidBook.state.source,
					config() ?? DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG
				)
		});
	}

	return {
		state: { subscribe: state.subscribe },
		sync,
		refreshNow,
		start
	};
}

function panelBidBookTokenId(context: TokenBiddingPanelBidBookContext): string | null {
	if (!context.open) {
		return null;
	}
	if (
		context.draft?.target.type !== BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TokenBatch ||
		context.draft.target.tokenIds.length !== 1
	) {
		return null;
	}
	const tokenId = biddingAutomationDraftTokenId(context.draft);
	return tokenId ?? null;
}

function emptyTokenBiddingPanelBidBookState(): TokenBiddingPanelBidBookState {
	return {
		tokenId: null,
		bidBook: emptyBiddingBidBook()
	};
}
