import {
	TRADING_BIDDING_AUTHORIZATION_STATUS,
	type TradingBiddingAuthorizationStatus
} from '@artgod/shared/types';
import type { ApiBiddingAuthorization } from '$lib/api-types';

// Labels the collection-level authorization field shared by bid-book summaries.
export const BIDDING_AUTHORIZATION_META_LABEL = 'bidding authorization';

const BIDDING_AUTHORIZATION_STATUS_LABELS = {
	[TRADING_BIDDING_AUTHORIZATION_STATUS.Included]: 'included',
	[TRADING_BIDDING_AUTHORIZATION_STATUS.NotIncluded]: 'not included',
	[TRADING_BIDDING_AUTHORIZATION_STATUS.UpdateRequired]: 'update required',
	[TRADING_BIDDING_AUTHORIZATION_STATUS.Inactive]: 'inactive',
	[TRADING_BIDDING_AUTHORIZATION_STATUS.Unavailable]: 'unavailable'
} as const satisfies Record<TradingBiddingAuthorizationStatus, string>;

// Formats the backend-owned authorization state without exposing internal mandate terminology.
export function biddingAuthorizationLabel(authorization: ApiBiddingAuthorization): string {
	return BIDDING_AUTHORIZATION_STATUS_LABELS[authorization.status];
}

// Explains the exact Admin action that can restore placement authority for an enabled job.
export function biddingAuthorizationRecoveryMessage(
	authorization: ApiBiddingAuthorization | null,
	collectionName: string
): string | null {
	if (!authorization) {
		return null;
	}
	if (authorization.status === TRADING_BIDDING_AUTHORIZATION_STATUS.NotIncluded) {
		return `Stop and start the bidding bot in Admin, then include ${collectionName} in the new bidding authorization.`;
	}
	if (authorization.status === TRADING_BIDDING_AUTHORIZATION_STATUS.UpdateRequired) {
		return `Stop and start the bidding bot in Admin, then review ${collectionName} in the new bidding authorization.`;
	}
	if (authorization.status === TRADING_BIDDING_AUTHORIZATION_STATUS.Unavailable) {
		return 'Stop and start the bidding bot in Admin to refresh its active bidding authorization.';
	}
	return null;
}
