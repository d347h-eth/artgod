import { BIDDING_CONFIG_ENV_KEY } from '@artgod/shared/config/bidding';
import { parseBoolean, parsePositiveInteger } from '@artgod/shared/utils/env';
import type { AdminConfigField, AdminConfigState } from '$lib/admin/configuration/ports';

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

export type BiddingStartPolicyEntry = {
	key: string;
	label: string;
	help: string;
	value: string;
};

// Builds the effective-policy summary from the same schema and values as Config.
export function buildBiddingStartPolicySummary(
	config: Pick<AdminConfigState, 'groups' | 'values'>
): BiddingStartPolicyEntry[] {
	const selectedFields = selectPolicyFields(config.groups.flatMap((group) => group.fields));
	return selectedFields.map((field) => ({
		key: field.key,
		label: field.label,
		help: field.help,
		value: formatPolicyValue(field.key, requireSetting(config.values, field.key))
	}));
}

function selectPolicyFields(fields: AdminConfigField[]): AdminConfigField[] {
	const selected = fields.filter((field) => BIDDING_SETTINGS_SUMMARY_KEYS.has(field.key));
	const selectedKeys = new Set(selected.map((field) => field.key));
	for (const key of BIDDING_SETTINGS_SUMMARY_KEYS) {
		if (!selectedKeys.has(key)) {
			throw new Error(`Missing effective bot policy field ${key}`);
		}
	}
	if (selected.length !== selectedKeys.size) {
		throw new Error('Effective bot policy fields contain duplicate keys.');
	}
	return selected;
}

function formatPolicyValue(key: string, value: string): string {
	if (key === BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers) {
		const enabled = parseBoolean(value, key, false);
		return enabled ? 'enabled · pinned OpenSea SignedZone trusted' : 'disabled';
	}
	if (key === BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds) {
		return formatOfferExpiration(value, key);
	}
	return value;
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
