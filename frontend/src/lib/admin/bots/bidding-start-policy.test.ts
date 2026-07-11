import { describe, expect, it } from 'vitest';
import { BIDDING_CONFIG_ENV_KEY } from '@artgod/shared/config/bidding';
import { buildBiddingStartPolicySummary } from './bidding-start-policy';

describe('buildBiddingStartPolicySummary', () => {
	it('shows the effective live caps and disabled trait trust', () => {
		expect(
			buildBiddingStartPolicySummary(
				makeValues({
					[BIDDING_CONFIG_ENV_KEY.DryRun]: 'false',
					[BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers]: 'false'
				})
			)
		).toEqual([
			{ label: 'mode', value: 'live orders' },
			{ label: 'WETH allowance cap', value: '1.5 WETH' },
			{ label: 'approval max fee / gas', value: '10 gwei' },
			{ label: 'approval total fee cap', value: '0.001 ETH' },
			{ label: 'pending nonce policy', value: 'fail' },
			{ label: 'trait and multi-trait offers', value: 'disabled' }
		]);
	});

	it('makes explicit when live trait placement trusts OpenSea SignedZone', () => {
		const summary = buildBiddingStartPolicySummary(
			makeValues({
				[BIDDING_CONFIG_ENV_KEY.DryRun]: 'true',
				[BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers]: 'true'
			})
		);

		expect(summary[0]).toEqual({ label: 'mode', value: 'dry run' });
		expect(summary.at(-1)).toEqual({
			label: 'trait and multi-trait offers',
			value: 'enabled · pinned OpenSea SignedZone trusted'
		});
	});

	it('fails closed when a required effective setting is missing', () => {
		const values = makeValues();
		delete values[BIDDING_CONFIG_ENV_KEY.TxMaxTotalFeeEth];

		expect(() => buildBiddingStartPolicySummary(values)).toThrow(
			BIDDING_CONFIG_ENV_KEY.TxMaxTotalFeeEth
		);
	});
});

function makeValues(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		[BIDDING_CONFIG_ENV_KEY.DryRun]: 'false',
		[BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers]: 'false',
		[BIDDING_CONFIG_ENV_KEY.WethAllowanceCapEth]: '1.5',
		[BIDDING_CONFIG_ENV_KEY.TxMaxFeeGwei]: '10',
		[BIDDING_CONFIG_ENV_KEY.TxMaxTotalFeeEth]: '0.001',
		[BIDDING_CONFIG_ENV_KEY.TxPendingNoncePolicy]: 'fail',
		...overrides
	};
}
