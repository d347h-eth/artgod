import { BIDDING_CONFIG_ENV_KEY } from '@artgod/shared/config/bidding';
import { EVM_PENDING_NONCE_POLICY } from '@artgod/shared/evm/transactions';
import { parseBoolean, parsePositiveInteger } from '@artgod/shared/utils/env';
import type { AdminConfigField, AdminConfigState } from '$lib/admin/configuration/ports';
import type { AdminBiddingStartPolicy } from '$lib/admin/bots/ports';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;

// Config-owned fields shown in the compact Bots bidding-settings summary.
const BIDDING_SETTINGS_SUMMARY_KEYS = new Set<string>([
	BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers,
	BIDDING_CONFIG_ENV_KEY.WethAllowanceCapEth,
	BIDDING_CONFIG_ENV_KEY.TxMinPriorityFeeGwei,
	BIDDING_CONFIG_ENV_KEY.TxMaxFeeGwei,
	BIDDING_CONFIG_ENV_KEY.WethApprovalMaxGasFeeEth,
	BIDDING_CONFIG_ENV_KEY.TxPendingNoncePolicy,
	BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds
]);

const ACTIVE_BIDDING_POLICY_KEYS = new Set<string>([
	BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers,
	BIDDING_CONFIG_ENV_KEY.WethAllowanceCapEth,
	BIDDING_CONFIG_ENV_KEY.TxMinPriorityFeeGwei,
	BIDDING_CONFIG_ENV_KEY.TxMaxFeeGwei,
	BIDDING_CONFIG_ENV_KEY.WethApprovalMaxGasFeeEth,
	BIDDING_CONFIG_ENV_KEY.TxPendingNoncePolicy
]);

export type BiddingSettingEntry = {
	key: string;
	label: string;
	help: string;
	value: string;
};

// Builds the effective-policy summary from the same schema and values as Config.
export function buildBiddingSettingsSummary(
	config: Pick<AdminConfigState, 'groups' | 'values'>
): BiddingSettingEntry[] {
	const selectedFields = selectPolicyFields(
		config.groups.flatMap((group) => group.fields),
		BIDDING_SETTINGS_SUMMARY_KEYS
	);
	return selectedFields.map((field) => ({
		key: field.key,
		label: field.label,
		help: field.help,
		value: formatCurrentSettingValue(field.key, requireSetting(config.values, field.key))
	}));
}

// Builds active authorization copy from the generation-frozen mandate and Config-owned labels/help.
export function buildActiveBiddingPolicySummary(
	config: Pick<AdminConfigState, 'groups'>,
	policy: AdminBiddingStartPolicy
): BiddingSettingEntry[] {
	const selectedFields = selectPolicyFields(
		config.groups.flatMap((group) => group.fields),
		ACTIVE_BIDDING_POLICY_KEYS
	);
	return selectedFields.map((field) => ({
		key: field.key,
		label: field.label,
		help: field.help,
		value: formatActivePolicyValue(field.key, policy)
	}));
}

function selectPolicyFields(
	fields: AdminConfigField[],
	expectedKeys: ReadonlySet<string>
): AdminConfigField[] {
	const selected = fields.filter((field) => expectedKeys.has(field.key));
	const selectedKeys = new Set(selected.map((field) => field.key));
	for (const key of expectedKeys) {
		if (!selectedKeys.has(key)) {
			throw new Error(`Missing effective bot policy field ${key}`);
		}
	}
	if (selected.length !== selectedKeys.size) {
		throw new Error('Effective bot policy fields contain duplicate keys.');
	}
	return selected;
}

function formatCurrentSettingValue(key: string, value: string): string {
	if (key === BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers) {
		const enabled = parseBoolean(value, key, false);
		return enabled ? "enabled · OpenSea's pinned SignedZone is trusted" : 'disabled';
	}
	if (key === BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds) {
		return formatOfferExpiration(value, key);
	}
	if (key === BIDDING_CONFIG_ENV_KEY.WethAllowanceCapEth) {
		return `${value} WETH for the OpenSea conduit`;
	}
	if (
		key === BIDDING_CONFIG_ENV_KEY.TxMinPriorityFeeGwei ||
		key === BIDDING_CONFIG_ENV_KEY.TxMaxFeeGwei
	) {
		return `${value} Gwei per gas`;
	}
	if (key === BIDDING_CONFIG_ENV_KEY.WethApprovalMaxGasFeeEth) {
		return `${value} ETH per approval transaction`;
	}
	if (key === BIDDING_CONFIG_ENV_KEY.TxPendingNoncePolicy) {
		if (value !== EVM_PENDING_NONCE_POLICY.Fail) {
			throw new Error(`Unsupported effective bot policy setting ${key}`);
		}
		return 'fail if the wallet already has pending transactions';
	}
	return value;
}

function formatActivePolicyValue(key: string, policy: AdminBiddingStartPolicy): string {
	if (key === BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers) {
		return policy.trustOpenSeaSignedZoneTraitOffers
			? "enabled · OpenSea's pinned SignedZone is trusted"
			: 'disabled';
	}
	if (key === BIDDING_CONFIG_ENV_KEY.WethAllowanceCapEth) {
		return `${formatBaseUnits(policy.wethAllowanceCapWei, 18, key)} WETH for the OpenSea conduit`;
	}
	if (key === BIDDING_CONFIG_ENV_KEY.TxMinPriorityFeeGwei) {
		return `${formatBaseUnits(policy.wethApproval.minPriorityFeePerGasWei, 9, key)} Gwei per gas`;
	}
	if (key === BIDDING_CONFIG_ENV_KEY.TxMaxFeeGwei) {
		return `${formatBaseUnits(policy.wethApproval.maxFeePerGasWei, 9, key)} Gwei per gas`;
	}
	if (key === BIDDING_CONFIG_ENV_KEY.WethApprovalMaxGasFeeEth) {
		return `${formatBaseUnits(policy.wethApproval.maxTotalGasFeeWei, 18, key)} ETH per approval transaction`;
	}
	if (key === BIDDING_CONFIG_ENV_KEY.TxPendingNoncePolicy) {
		if (policy.wethApproval.pendingNoncePolicy !== EVM_PENDING_NONCE_POLICY.Fail) {
			throw new Error(`Unsupported active bidding policy setting ${key}`);
		}
		return 'fail if the wallet already has pending transactions';
	}
	throw new Error(`Unsupported active bidding policy field ${key}`);
}

function formatBaseUnits(value: string, decimals: number, key: string): string {
	if (!/^(0|[1-9]\d*)$/.test(value)) {
		throw new Error(`Invalid active bidding policy setting ${key}`);
	}
	const padded = value.padStart(decimals + 1, '0');
	const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, '');
	const fraction = padded.slice(-decimals).replace(/0+$/, '');
	return fraction ? `${whole}.${fraction}` : whole;
}

function formatOfferExpiration(value: string, key: string): string {
	const totalSeconds = parsePositiveInteger(value, key);
	const days = Math.floor(totalSeconds / SECONDS_PER_DAY);
	const hours = Math.floor((totalSeconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
	const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
	const readableParts: string[] = [];

	if (totalSeconds >= SECONDS_PER_DAY) readableParts.push(formatCount(days, 'day'));
	if (totalSeconds >= SECONDS_PER_HOUR) readableParts.push(formatCount(hours, 'hour'));
	readableParts.push(formatCount(minutes, 'minute'));

	return `${formatCount(totalSeconds, 'second')} (${readableParts.join(', ')})`;
}

function formatCount(value: number, unit: 'day' | 'hour' | 'minute' | 'second'): string {
	return `${value} ${unit}${value === 1 ? '' : 's'}`;
}

function requireSetting(values: Record<string, string>, key: string): string {
	const value = values[key]?.trim();
	if (!value) {
		throw new Error(`Missing effective bot policy setting ${key}`);
	}
	return value;
}
