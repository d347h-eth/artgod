import { describe, expect, it } from 'vitest';
import { BIDDING_CONFIG_ENV_KEY } from '@artgod/shared/config/bidding';
import type { AdminConfigField, AdminConfigState } from '$lib/admin/configuration/ports';
import {
	buildActiveBiddingPolicySummary,
	buildBiddingSettingsSummary
} from './bidding-start-policy';

describe('buildBiddingSettingsSummary', () => {
	it('uses config-owned field order, labels, help, and effective values', () => {
		const summary = buildBiddingSettingsSummary(
			makeConfig({
				[BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers]: 'false'
			})
		);

		expect(summary).toEqual([
			entry(BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers, 'disabled'),
			entry(BIDDING_CONFIG_ENV_KEY.WethAllowanceCapEth, '1.5 WETH for the OpenSea conduit'),
			entry(BIDDING_CONFIG_ENV_KEY.TxMinPriorityFeeGwei, '0.25 Gwei per gas'),
			entry(BIDDING_CONFIG_ENV_KEY.TxMaxFeeGwei, '10 Gwei per gas'),
			entry(
				BIDDING_CONFIG_ENV_KEY.WethApprovalMaxGasFeeEth,
				'0.005 ETH per approval transaction'
			),
			entry(
				BIDDING_CONFIG_ENV_KEY.TxPendingNoncePolicy,
				'fail if the wallet already has pending transactions'
			),
			entry(
				BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds,
				'13920 seconds (3 hours, 52 minutes)'
			)
		]);
		expect(summary.some((entry) => entry.key === BIDDING_CONFIG_ENV_KEY.DryRun)).toBe(false);
		expect(summary.some((entry) => entry.key === BIDDING_CONFIG_ENV_KEY.TxBaseFeeMultiplier)).toBe(
			false
		);
	});

	it('uses the canonical Config label and help for offer lifetime and priority fee', () => {
		const summary = buildBiddingSettingsSummary(makeConfig());

		expect(
			summary.find((entry) => entry.key === BIDDING_CONFIG_ENV_KEY.TxMinPriorityFeeGwei)
		).toEqual({
			key: BIDDING_CONFIG_ENV_KEY.TxMinPriorityFeeGwei,
			...CANONICAL_CONFIG_COPY[BIDDING_CONFIG_ENV_KEY.TxMinPriorityFeeGwei],
			value: '0.25 Gwei per gas'
		});
		expect(
			summary.find((entry) => entry.key === BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds)
		).toEqual({
			key: BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds,
			...CANONICAL_CONFIG_COPY[BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds],
			value: '13920 seconds (3 hours, 52 minutes)'
		});
	});

	it.each([
		['1', '1 second (0 minutes)'],
		['59', '59 seconds (0 minutes)'],
		['60', '60 seconds (1 minute)'],
		['3600', '3600 seconds (1 hour, 0 minutes)'],
		['3660', '3660 seconds (1 hour, 1 minute)'],
		['90060', '90060 seconds (1 day, 1 hour, 1 minute)'],
		['176520', '176520 seconds (2 days, 1 hour, 2 minutes)']
	])('shows exact offer seconds with the readable duration for %s', (value, expected) => {
		const summary = buildBiddingSettingsSummary(
			makeConfig({ [BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds]: value })
		);

		expect(
			summary.find((entry) => entry.key === BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds)?.value
		).toBe(expected);
	});

	it.each(['0', '1.5', 'invalid'])('fails closed for invalid offer lifetime %s', (value) => {
		const config = makeConfig({ [BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds]: value });

		expect(() => buildBiddingSettingsSummary(config)).toThrow(
			BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds
		);
	});

	it('makes explicit when live trait placement trusts OpenSea SignedZone', () => {
		const summary = buildBiddingSettingsSummary(
			makeConfig({
				[BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers]: 'true'
			})
		);

		expect(summary[0]).toEqual(
			entry(
				BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers,
				"enabled · OpenSea's pinned SignedZone is trusted"
			)
		);
	});

	it.each(['1', 'yes', 'on'])('uses the shared true spelling %s', (value) => {
		const summary = buildBiddingSettingsSummary(
			makeConfig({
				[BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers]: value
			})
		);

		expect(summary[0]?.value).toBe("enabled · OpenSea's pinned SignedZone is trusted");
	});

	it.each(['0', 'no', 'off'])('uses the shared false spelling %s', (value) => {
		const summary = buildBiddingSettingsSummary(
			makeConfig({
				[BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers]: value
			})
		);

		expect(summary[0]?.value).toBe('disabled');
	});

	it.each(EXPECTED_SUMMARY_KEYS)('fails closed when required value %s is missing', (key) => {
		const missingValue = makeConfig();
		delete missingValue.values[key];

		expect(() => buildBiddingSettingsSummary(missingValue)).toThrow(key);
	});

	it.each(EXPECTED_SUMMARY_KEYS)('fails closed when required schema field %s is missing', (key) => {
		const missingField = makeConfig();
		missingField.groups[0].fields = missingField.groups[0].fields.filter(
			(field) => field.key !== key
		);
		expect(() => buildBiddingSettingsSummary(missingField)).toThrow(key);
	});

	it('formats the generation-frozen active policy with exact units and scope', () => {
		const summary = buildActiveBiddingPolicySummary(makeConfig(), {
			wethAllowanceCapWei: '1500000000000000000',
			trustOpenSeaSignedZoneTraitOffers: true,
			wethApproval: {
				minPriorityFeePerGasWei: '250000000',
				maxFeePerGasWei: '10000000000',
				maxTotalGasFeeWei: '5000000000000000',
				pendingNoncePolicy: 'fail'
			}
		});

		expect(summary.map((entry) => entry.value)).toEqual([
			"enabled · OpenSea's pinned SignedZone is trusted",
			'1.5 WETH for the OpenSea conduit',
			'0.25 Gwei per gas',
			'10 Gwei per gas',
			'0.005 ETH per approval transaction',
			'fail if the wallet already has pending transactions'
		]);
		expect(summary.some((entry) => entry.key === BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds)).toBe(
			false
		);
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
		label: 'minimum priority fee per gas',
		help: 'Minimum EIP-1559 priority fee in Gwei per gas for the WETH approval transaction.'
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
