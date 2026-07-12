import { describe, expect, it } from 'vitest';
import {
	TRADING_BIDDING_AUTHORIZATION_STATUS,
	type TradingBiddingAuthorizationStatus
} from '@artgod/shared/types';
import type { ApiBiddingAuthorization } from '$lib/api-types';
import { biddingAuthorizationRecoveryMessage } from '$lib/bidding-authorization';

function authorization(status: TradingBiddingAuthorizationStatus): ApiBiddingAuthorization {
	return {
		status,
		maxUnitBidWei: null,
		maxUnitBidEth: null,
		maxQuantity: null
	};
}

describe('bidding authorization presentation', () => {
	it.each([
		[
			TRADING_BIDDING_AUTHORIZATION_STATUS.NotIncluded,
			'Stop and start the bidding bot in Admin, then include milady in the new bidding authorization.'
		],
		[
			TRADING_BIDDING_AUTHORIZATION_STATUS.UpdateRequired,
			'Stop and start the bidding bot in Admin, then review milady in the new bidding authorization.'
		],
		[
			TRADING_BIDDING_AUTHORIZATION_STATUS.Unavailable,
			'Stop and start the bidding bot in Admin to refresh its active bidding authorization.'
		]
	])('provides the recovery action for %s', (status, message) => {
		expect(biddingAuthorizationRecoveryMessage(authorization(status), 'milady')).toBe(message);
	});

	it.each([
		TRADING_BIDDING_AUTHORIZATION_STATUS.Included,
		TRADING_BIDDING_AUTHORIZATION_STATUS.Inactive
	])('does not prescribe an authorization restart for %s', (status) => {
		expect(biddingAuthorizationRecoveryMessage(authorization(status), 'milady')).toBeNull();
	});
});
