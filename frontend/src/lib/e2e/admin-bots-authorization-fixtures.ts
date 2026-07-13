import { BIDDING_CONFIG_ENV_KEY } from '@artgod/shared/config/bidding';
import { EVM_PENDING_NONCE_POLICY } from '@artgod/shared/evm/transactions';
import { TRADING_BOT_KIND } from '@artgod/shared/types';
import type { AdminConfigField, AdminConfigState } from '$lib/admin/configuration/ports';
import {
	ADMIN_BOT_STATE,
	type AdminBiddingCollectionCatalog,
	type AdminBiddingMandate,
	type AdminBiddingMandateDraft,
	type AdminBotKind,
	type AdminBotPort,
	type AdminBotRecord,
	type AdminBotState
} from '$lib/admin/bots/ports';
import type { AdminWalletPort, AdminWalletRecord } from '$lib/admin/wallets/ports';

// Query key owned by the deterministic Admin bidding authorization harness.
export const ADMIN_BOTS_AUTHORIZATION_SCENARIO_QUERY_PARAM = 'scenario';

// Mirrors the native recovery returned when authorization data cannot reach infra.
export const ADMIN_BOTS_INFRASTRUCTURE_OFFLINE_MESSAGE =
	'Start infra to prepare bidding authorization.';

// Materially different Admin states covered by rendered authorization verification.
export const ADMIN_BOTS_AUTHORIZATION_SCENARIO = {
	Stopped: 'stopped',
	Draft: 'draft',
	AwaitingUnlock: 'awaiting_unlock',
	Bootstrapping: 'bootstrapping',
	Active: 'active',
	ConfigDrift: 'config_drift',
	ValidationError: 'validation_error',
	InfrastructureOffline: 'infrastructure_offline'
} as const;

export type AdminBotsAuthorizationScenario =
	(typeof ADMIN_BOTS_AUTHORIZATION_SCENARIO)[keyof typeof ADMIN_BOTS_AUTHORIZATION_SCENARIO];

const WALLET: AdminWalletRecord = {
	walletId: '11111111-1111-4111-8111-111111111111',
	label: 'Bidding wallet',
	address: '0x1111111111111111111111111111111111111111',
	assignedBotKinds: [TRADING_BOT_KIND.Bidding],
	status: 'stored'
};

const CATALOG: AdminBiddingCollectionCatalog = {
	chain: { chainId: 1, name: 'Ethereum' },
	maxOfferQuantity: 1,
	collections: [
		{
			chainId: 1,
			collectionId: 7,
			artgodSlug: 'example',
			contractAddress: '0x2222222222222222222222222222222222222222',
			openseaSlug: 'example-opensea',
			tokenScope: {
				label: 'token range',
				items: [
					{ label: 'start token', value: '0' },
					{ label: 'total supply', value: '9911' }
				]
			},
			jobCeilingPrefillEth: '1.25'
		}
	]
};

const ACTIVE_MANDATE: AdminBiddingMandate = {
	chainId: 1,
	startPolicy: {
		wethAllowanceCapWei: '500000000000000000',
		trustOpenSeaSignedZoneTraitOffers: true,
		wethApproval: {
			minPriorityFeePerGasWei: '100000000',
			maxFeePerGasWei: '10000000000',
			maxTotalGasFeeWei: '10000000000000000',
			pendingNoncePolicy: EVM_PENDING_NONCE_POLICY.Fail
		}
	},
	collections: [
		{
			collectionId: 7,
			artgodSlug: 'example',
			contractAddress: '0x2222222222222222222222222222222222222222',
			openseaSlug: 'example-opensea',
			tokenScope: CATALOG.collections[0].tokenScope,
			maxUnitBidWei: '1250000000000000000',
			maxQuantity: 1
		}
	]
};

// Resolves and validates the requested deterministic harness state.
export function parseAdminBotsAuthorizationScenario(
	searchParams: URLSearchParams
): AdminBotsAuthorizationScenario {
	const requested = searchParams.get(ADMIN_BOTS_AUTHORIZATION_SCENARIO_QUERY_PARAM);
	const scenarios = Object.values(ADMIN_BOTS_AUTHORIZATION_SCENARIO);
	return scenarios.includes(requested as AdminBotsAuthorizationScenario)
		? (requested as AdminBotsAuthorizationScenario)
		: ADMIN_BOTS_AUTHORIZATION_SCENARIO.Stopped;
}

// Builds faithful injected Admin ports and Config state for one rendered scenario.
export function createAdminBotsAuthorizationFixture(scenario: AdminBotsAuthorizationScenario): {
	config: AdminConfigState;
	botPort: AdminBotPort;
	walletPort: AdminWalletPort;
} {
	let record = botRecord(resolveState(scenario), hasActiveMandate(scenario) ? ACTIVE_MANDATE : null);
	const botPort: AdminBotPort = {
		async listBots() {
			return [record];
		},
		async loadBiddingCollectionCatalog() {
			if (scenario === ADMIN_BOTS_AUTHORIZATION_SCENARIO.InfrastructureOffline) {
				throw new Error(ADMIN_BOTS_INFRASTRUCTURE_OFFLINE_MESSAGE);
			}
			return CATALOG;
		},
		async assignWallet(_botKind: AdminBotKind, walletId: string | null) {
			record = { ...record, assignedWallet: walletId ? assignedWallet() : null };
			return record;
		},
		async startBot(_botKind: AdminBotKind, _draft: AdminBiddingMandateDraft | null) {
			record = { ...record, state: ADMIN_BOT_STATE.Starting, biddingMandate: ACTIVE_MANDATE };
			return record;
		},
		async stopBot() {
			record = { ...record, state: ADMIN_BOT_STATE.Stopped, biddingMandate: null };
			return record;
		},
		async onStateChanged() {
			return () => undefined;
		}
	};
	const walletPort: AdminWalletPort = {
		async getStatus() {
			return {
				configuredWalletCount: 1,
				supportedActions: ['import', 'export', 'remove'],
				custodyBoundary: 'native_prompt'
			};
		},
		async listWallets() {
			return [WALLET];
		},
		async importWallet() {
			return { outcome: 'cancelled' };
		},
		async exportWallet() {
			return { outcome: 'cancelled' };
		},
		async removeWallet() {
			return { outcome: 'cancelled' };
		}
	};

	return { config: configState(scenario), botPort, walletPort };
}

function resolveState(scenario: AdminBotsAuthorizationScenario): AdminBotState {
	if (scenario === ADMIN_BOTS_AUTHORIZATION_SCENARIO.AwaitingUnlock) {
		return ADMIN_BOT_STATE.AwaitingUnlock;
	}
	if (scenario === ADMIN_BOTS_AUTHORIZATION_SCENARIO.Bootstrapping) {
		return ADMIN_BOT_STATE.Bootstrapping;
	}
	if (
		scenario === ADMIN_BOTS_AUTHORIZATION_SCENARIO.Active ||
		scenario === ADMIN_BOTS_AUTHORIZATION_SCENARIO.ConfigDrift
	) {
		return ADMIN_BOT_STATE.Running;
	}
	return ADMIN_BOT_STATE.Stopped;
}

function hasActiveMandate(scenario: AdminBotsAuthorizationScenario): boolean {
	return (
		scenario === ADMIN_BOTS_AUTHORIZATION_SCENARIO.Bootstrapping ||
		scenario === ADMIN_BOTS_AUTHORIZATION_SCENARIO.Active ||
		scenario === ADMIN_BOTS_AUTHORIZATION_SCENARIO.ConfigDrift
	);
}

function botRecord(state: AdminBotState, biddingMandate: AdminBiddingMandate | null): AdminBotRecord {
	return {
		botKind: TRADING_BOT_KIND.Bidding,
		processName: 'trading-bidding-bot',
		state,
		lastError: null,
		disabledReason: null,
		criticalDependencies: [],
		assignedWallet: assignedWallet(),
		biddingMandate
	};
}

function assignedWallet() {
	return {
		walletId: WALLET.walletId,
		label: WALLET.label,
		address: WALLET.address,
		status: WALLET.status
	};
}

function configState(scenario: AdminBotsAuthorizationScenario): AdminConfigState {
	const values: Record<string, string> = {
		[BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers]: 'true',
		[BIDDING_CONFIG_ENV_KEY.WethAllowanceCapEth]: '0.5',
		[BIDDING_CONFIG_ENV_KEY.TxMinPriorityFeeGwei]: '0.1',
		[BIDDING_CONFIG_ENV_KEY.TxMaxFeeGwei]: '10',
		[BIDDING_CONFIG_ENV_KEY.WethApprovalMaxGasFeeEth]: '0.01',
		[BIDDING_CONFIG_ENV_KEY.TxPendingNoncePolicy]: EVM_PENDING_NONCE_POLICY.Fail,
		[BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds]: '13920'
	};
	if (scenario === ADMIN_BOTS_AUTHORIZATION_SCENARIO.ConfigDrift) {
		Object.assign(values, {
			[BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers]: 'false',
			[BIDDING_CONFIG_ENV_KEY.WethAllowanceCapEth]: '9',
			[BIDDING_CONFIG_ENV_KEY.TxMinPriorityFeeGwei]: '1',
			[BIDDING_CONFIG_ENV_KEY.TxMaxFeeGwei]: '20',
			[BIDDING_CONFIG_ENV_KEY.WethApprovalMaxGasFeeEth]: '0.2'
		});
	}
	if (scenario === ADMIN_BOTS_AUTHORIZATION_SCENARIO.ValidationError) {
		delete values[BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds];
	}
	const fields = biddingSettingFields();
	return {
		configured: true,
		envFilePath: 'config/.env',
		envFileExists: true,
		settingsFilePath: 'config/settings.json',
		settingsFileExists: true,
		autoLaunchOnStartup: false,
		values,
		defaults: { ...values },
		groups: [{ id: 'bidding', label: 'Bidding', fields }]
	};
}

function biddingSettingFields(): AdminConfigField[] {
	return [
		field(
			BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers,
			'trust OpenSea SignedZone for trait offers',
			"Explicitly allows live trait offers through OpenSea's pinned SignedZone."
		),
		field(
			BIDDING_CONFIG_ENV_KEY.WethAllowanceCapEth,
			'WETH allowance cap',
			'Exact OpenSea conduit allowance cap in WETH.'
		),
		field(
			BIDDING_CONFIG_ENV_KEY.TxMinPriorityFeeGwei,
			'minimum priority fee per gas',
			'Minimum EIP-1559 priority fee in Gwei per gas for the WETH approval transaction.'
		),
		field(
			BIDDING_CONFIG_ENV_KEY.TxMaxFeeGwei,
			'maximum fee per gas',
			'Maximum fee in Gwei per gas for the WETH approval transaction.'
		),
		field(
			BIDDING_CONFIG_ENV_KEY.WethApprovalMaxGasFeeEth,
			'maximum network fee for one WETH approval transaction',
			'Maximum worst-case network fee in ETH for one WETH approval transaction.'
		),
		field(
			BIDDING_CONFIG_ENV_KEY.TxPendingNoncePolicy,
			'pending transaction policy',
			'Fail the start before approval when the wallet already has pending transactions.'
		),
		field(
			BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds,
			'bidding offer expiration seconds',
			'Lifetime in seconds for each newly created OpenSea offer.'
		)
	];
}

function field(key: string, label: string, help: string): AdminConfigField {
	return {
		key,
		label,
		inputKind: 'text',
		secret: false,
		options: [],
		help,
		requiredForLaunch: false,
		validation: null
	};
}
