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
			entry(BIDDING_CONFIG_ENV_KEY.TxMaxFeeGwei, '10'),
			entry(BIDDING_CONFIG_ENV_KEY.WethApprovalMaxGasFeeEth, '0.005'),
			entry(BIDDING_CONFIG_ENV_KEY.TxPendingNoncePolicy, 'fail')
		]);
		expect(summary.some((entry) => entry.key === BIDDING_CONFIG_ENV_KEY.DryRun)).toBe(false);
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

	it('fails closed when a required effective field or value is missing', () => {
		const missingValue = makeConfig();
		delete missingValue.values[BIDDING_CONFIG_ENV_KEY.WethApprovalMaxGasFeeEth];

		expect(() => buildBiddingStartPolicySummary(missingValue)).toThrow(
			BIDDING_CONFIG_ENV_KEY.WethApprovalMaxGasFeeEth
		);

		const missingField = makeConfig();
		missingField.groups[0].fields = missingField.groups[0].fields.filter(
			(field) => field.key !== BIDDING_CONFIG_ENV_KEY.WethAllowanceCapEth
		);
		expect(() => buildBiddingStartPolicySummary(missingField)).toThrow(
			'Missing effective bot policy field'
		);
	});
});

const CONFIG_FIELD_KEYS = [
	BIDDING_CONFIG_ENV_KEY.DryRun,
	BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers,
	BIDDING_CONFIG_ENV_KEY.WethAllowanceCapEth,
	BIDDING_CONFIG_ENV_KEY.TxMaxFeeGwei,
	BIDDING_CONFIG_ENV_KEY.WethApprovalMaxGasFeeEth,
	BIDDING_CONFIG_ENV_KEY.TxPendingNoncePolicy
];

function makeConfig(
	overrides: Record<string, string> = {}
): Pick<AdminConfigState, 'groups' | 'values'> {
	return {
		groups: [{ id: 'bidding', label: 'Bidding', fields: CONFIG_FIELD_KEYS.map(field) }],
		values: {
			[BIDDING_CONFIG_ENV_KEY.DryRun]: 'false',
			[BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers]: 'false',
			[BIDDING_CONFIG_ENV_KEY.WethAllowanceCapEth]: '1.5',
			[BIDDING_CONFIG_ENV_KEY.TxMaxFeeGwei]: '10',
			[BIDDING_CONFIG_ENV_KEY.WethApprovalMaxGasFeeEth]: '0.005',
			[BIDDING_CONFIG_ENV_KEY.TxPendingNoncePolicy]: 'fail',
			...overrides
		}
	};
}

function field(key: string): AdminConfigField {
	return {
		key,
		label: `label ${key}`,
		inputKind: 'text',
		secret: false,
		options: [],
		help: `help ${key}`,
		requiredForLaunch: false,
		validation: null
	};
}

function entry(key: string, value: string) {
	return { key, label: `label ${key}`, help: `help ${key}`, value };
}
