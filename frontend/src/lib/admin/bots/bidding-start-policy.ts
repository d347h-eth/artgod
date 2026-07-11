import { BIDDING_CONFIG_ENV_KEY } from '@artgod/shared/config/bidding';

export type BiddingStartPolicyEntry = {
	label: string;
	value: string;
};

// Builds the compact effective-policy summary shown immediately before bidding bot start.
export function buildBiddingStartPolicySummary(
	values: Record<string, string>
): BiddingStartPolicyEntry[] {
	const dryRun = parseBooleanSetting(values, BIDDING_CONFIG_ENV_KEY.DryRun);
	const trustTraitOffers = parseBooleanSetting(
		values,
		BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers
	);
	return [
		{
			label: 'mode',
			value: dryRun ? 'dry run' : 'live orders'
		},
		{
			label: 'WETH allowance cap',
			value: `${requireSetting(values, BIDDING_CONFIG_ENV_KEY.WethAllowanceCapEth)} WETH`
		},
		{
			label: 'approval max fee / gas',
			value: `${requireSetting(values, BIDDING_CONFIG_ENV_KEY.TxMaxFeeGwei)} gwei`
		},
		{
			label: 'approval max gas fee',
			value: `${requireSetting(values, BIDDING_CONFIG_ENV_KEY.WethApprovalMaxGasFeeEth)} ETH`
		},
		{
			label: 'pending nonce policy',
			value: requireSetting(values, BIDDING_CONFIG_ENV_KEY.TxPendingNoncePolicy)
		},
		{
			label: 'trait and multi-trait offers',
			value: trustTraitOffers ? 'enabled · pinned OpenSea SignedZone trusted' : 'disabled'
		}
	];
}

function parseBooleanSetting(values: Record<string, string>, key: string): boolean {
	const value = requireSetting(values, key).trim().toLowerCase();
	if (value === 'true') return true;
	if (value === 'false') return false;
	throw new Error(`Invalid effective bot policy setting ${key}: ${value}`);
}

function requireSetting(values: Record<string, string>, key: string): string {
	const value = values[key]?.trim();
	if (!value) {
		throw new Error(`Missing effective bot policy setting ${key}`);
	}
	return value;
}
