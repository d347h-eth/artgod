import {
	DEFAULT_TRADING_BIDDING_PRICE_DELTA_ETH,
	TRADING_BIDDING_TIER_SELECTION_MODE
} from '@artgod/shared/types';
import type { ApiBiddingCollectionSettings } from '$lib/api-types';

// Provides browser-side defaults for routes that cannot load admin bidding settings.
export function defaultBiddingCollectionSettings(): ApiBiddingCollectionSettings {
	return {
		tierSelectionMode: TRADING_BIDDING_TIER_SELECTION_MODE.Buttons,
		defaultDeltaEth: DEFAULT_TRADING_BIDDING_PRICE_DELTA_ETH,
		updatedAt: null
	};
}
