import { describe, expect, it } from 'vitest';
import { BIDDING_CONFIG_ENV_KEY } from '@artgod/shared/config/bidding';
import type { AdminConfigField, AdminConfigState } from '$lib/admin/configuration/ports';
import { buildBiddingStartPolicySummary } from './bidding-start-policy';

describe('buildBiddingStartPolicySummary', () => {
	it('uses config-owned field order, labels, help, and effective values', () => {
		const summary = buildBiddingStartPolicySummary(
			makeConfig({
				[BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers]: 'false'
			})
		);

		expect(summary).toEqual([
			entry(BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers, 'disabled'),
			entry(BIDDING_CONFIG_ENV_KEY.WethAllowanceCapEth, '1.5'),
			entry(BIDDING_CONFIG_ENV_KEY.TxMinPriorityFeeGwei, '0.25'),
			entry(BIDDING_CONFIG_ENV_KEY.TxMaxFeeGwei, '10'),
			entry(BIDDING_CONFIG_ENV_KEY.WethApprovalMaxGasFeeEth, '0.005'),
			entry(BIDDING_CONFIG_ENV_KEY.TxPendingNoncePolicy, 'fail'),
			entry(BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds, '13920')
		]);
		expect(summary.some((entry) => entry.key === BIDDING_CONFIG_ENV_KEY.DryRun)).toBe(false);
		expect(summary.some((entry) => entry.key === BIDDING_CONFIG_ENV_KEY.TxBaseFeeMultiplier)).toBe(
			false
		);
	});

	it('uses the canonical Config label and help for offer lifetime and priority fee', () => {
		const summary = buildBiddingStartPolicySummary(makeConfig());

		expect(
			summary.find((entry) => entry.key === BIDDING_CONFIG_ENV_KEY.TxMinPriorityFeeGwei)
		).toEqual({
			key: BIDDING_CONFIG_ENV_KEY.TxMinPriorityFeeGwei,
			...CANONICAL_CONFIG_COPY[BIDDING_CONFIG_ENV_KEY.TxMinPriorityFeeGwei],
			value: '0.25'
		});
		expect(
			summary.find((entry) => entry.key === BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds)
		).toEqual({
			key: BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds,
			...CANONICAL_CONFIG_COPY[BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds],
			value: '13920'
		});
	});

	it('makes explicit when live trait placement trusts OpenSea SignedZone', () => {
		const summary = buildBiddingStartPolicySummary(
			makeConfig({
				[BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers]: 'true'
			})
		);

		expect(summary[0]).toEqual(
			entry(
				BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers,
				'enabled · pinned OpenSea SignedZone trusted'
			)
		);
	});

	it.each(['1', 'yes', 'on'])('uses the shared true spelling %s', (value) => {
		const summary = buildBiddingStartPolicySummary(
			makeConfig({
				[BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers]: value
			})
		);

		expect(summary[0]?.value).toBe('enabled · pinned OpenSea SignedZone trusted');
	});

	it.each(['0', 'no', 'off'])('uses the shared false spelling %s', (value) => {
		const summary = buildBiddingStartPolicySummary(
			makeConfig({
				[BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers]: value
			})
		);

		expect(summary[0]?.value).toBe('disabled');
	});

	it.each(EXPECTED_SUMMARY_KEYS)('fails closed when required value %s is missing', (key) => {
		const missingValue = makeConfig();
		delete missingValue.values[key];

		expect(() => buildBiddingStartPolicySummary(missingValue)).toThrow(key);
	});

	it.each(EXPECTED_SUMMARY_KEYS)('fails closed when required schema field %s is missing', (key) => {
		const missingField = makeConfig();
		missingField.groups[0].fields = missingField.groups[0].fields.filter(
			(field) => field.key !== key
		);
		expect(() => buildBiddingStartPolicySummary(missingField)).toThrow(key);
	});
});

const CONFIG_FIELD_KEYS = [
	BIDDING_CONFIG_ENV_KEY.Enabled,
	BIDDING_CONFIG_ENV_KEY.DryRun,
	BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers,
	BIDDING_CONFIG_ENV_KEY.WethAllowanceCapEth,
	BIDDING_CONFIG_ENV_KEY.TxMinPriorityFeeGwei,
	BIDDING_CONFIG_ENV_KEY.TxBaseFeeMultiplier,
	BIDDING_CONFIG_ENV_KEY.TxMaxFeeGwei,
	BIDDING_CONFIG_ENV_KEY.WethApprovalMaxGasFeeEth,
	BIDDING_CONFIG_ENV_KEY.TxPendingNoncePolicy,
	BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds
];

const EXPECTED_SUMMARY_KEYS = [
	BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers,
	BIDDING_CONFIG_ENV_KEY.WethAllowanceCapEth,
	BIDDING_CONFIG_ENV_KEY.TxMinPriorityFeeGwei,
	BIDDING_CONFIG_ENV_KEY.TxMaxFeeGwei,
	BIDDING_CONFIG_ENV_KEY.WethApprovalMaxGasFeeEth,
	BIDDING_CONFIG_ENV_KEY.TxPendingNoncePolicy,
	BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds
];

const CANONICAL_CONFIG_COPY: Partial<Record<string, { label: string; help: string }>> = {
	[BIDDING_CONFIG_ENV_KEY.TxMinPriorityFeeGwei]: {
		label: 'bidding tx min priority fee gwei',
		help: 'Minimum EIP-1559 priority fee for bidding transactions, in gwei.'
	},
	[BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds]: {
		label: 'bidding offer expiration seconds',
		help: 'Lifetime in seconds for each newly created OpenSea offer.'
	}
};

function makeConfig(
	overrides: Record<string, string> = {}
): Pick<AdminConfigState, 'groups' | 'values'> {
	return {
		groups: [{ id: 'bidding', label: 'Bidding', fields: CONFIG_FIELD_KEYS.map(field) }],
		values: {
			[BIDDING_CONFIG_ENV_KEY.Enabled]: 'true',
			[BIDDING_CONFIG_ENV_KEY.DryRun]: 'false',
			[BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers]: 'false',
			[BIDDING_CONFIG_ENV_KEY.WethAllowanceCapEth]: '1.5',
			[BIDDING_CONFIG_ENV_KEY.TxMinPriorityFeeGwei]: '0.25',
			[BIDDING_CONFIG_ENV_KEY.TxBaseFeeMultiplier]: '1.25',
			[BIDDING_CONFIG_ENV_KEY.TxMaxFeeGwei]: '10',
			[BIDDING_CONFIG_ENV_KEY.WethApprovalMaxGasFeeEth]: '0.005',
			[BIDDING_CONFIG_ENV_KEY.TxPendingNoncePolicy]: 'fail',
			[BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds]: '13920',
			...overrides
		}
	};
}

function field(key: string): AdminConfigField {
	const copy = CANONICAL_CONFIG_COPY[key] ?? {
		label: `label ${key}`,
		help: `help ${key}`
	};
	return {
		key,
		label: copy.label,
		inputKind: 'text',
		secret: false,
		options: [],
		help: copy.help,
		requiredForLaunch: false,
		validation: null
	};
}

function entry(key: string, value: string) {
	const configField = field(key);
	return { key, label: configField.label, help: configField.help, value };
}
