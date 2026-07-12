import type { EvmPendingNoncePolicy } from '@artgod/shared/evm/transactions';

export type AdminBotKind = 'bidding' | 'sniping';

// Owns the desktop supervisor states exposed to the Admin bot controller.
export const ADMIN_BOT_STATE = {
	Disabled: 'disabled',
	Locked: 'locked',
	AwaitingUnlock: 'awaiting_unlock',
	Starting: 'starting',
	Bootstrapping: 'bootstrapping',
	Running: 'running',
	Stopped: 'stopped',
	Error: 'error'
} as const;

export type AdminBotState = (typeof ADMIN_BOT_STATE)[keyof typeof ADMIN_BOT_STATE];

const ADMIN_BOT_STATE_LABEL: Record<AdminBotState, string> = {
	[ADMIN_BOT_STATE.Disabled]: 'unavailable',
	[ADMIN_BOT_STATE.Locked]: 'locked',
	[ADMIN_BOT_STATE.AwaitingUnlock]: 'waiting for wallet unlock',
	[ADMIN_BOT_STATE.Starting]: 'starting',
	[ADMIN_BOT_STATE.Bootstrapping]: 'preparing bidding',
	[ADMIN_BOT_STATE.Running]: 'running',
	[ADMIN_BOT_STATE.Stopped]: 'stopped',
	[ADMIN_BOT_STATE.Error]: 'failed'
};

// Translates supervisor states into lifecycle language shown to the Admin user.
export function formatAdminBotState(state: AdminBotState): string {
	return ADMIN_BOT_STATE_LABEL[state];
}

// Identifies states in which the native start flow or bot process holds authority.
export function isAdminBotActive(state: AdminBotState): boolean {
	return (
		state === ADMIN_BOT_STATE.AwaitingUnlock ||
		state === ADMIN_BOT_STATE.Starting ||
		state === ADMIN_BOT_STATE.Bootstrapping ||
		state === ADMIN_BOT_STATE.Running
	);
}

export type AdminBotAssignedWallet = {
	walletId: string;
	label: string;
	address: string;
	status: 'stored';
};

export type AdminBotCriticalDependency = {
	process: string;
	healthy: boolean;
};

export type AdminBiddingTokenScopeSummary = {
	label: string;
	items: Array<{ label: string; value: string }>;
};

export type AdminBiddingChainIdentity = {
	chainId: number;
	name: string;
};

// Identity fields shared by catalog candidates and active authorizations.
export type AdminBiddingCollectionIdentity = {
	collectionId: number;
	artgodSlug: string;
	contractAddress: string;
	openseaSlug: string;
	tokenScope: AdminBiddingTokenScopeSummary;
};

// Catalog-only collection data used to initialize an authorization request.
export type AdminBiddingCollectionCandidate = AdminBiddingCollectionIdentity & {
	chainId: number;
	jobCeilingPrefillEth: string;
};

export type AdminBiddingCollectionCatalog = {
	chain: AdminBiddingChainIdentity;
	maxOfferQuantity: number;
	collections: AdminBiddingCollectionCandidate[];
};

export type AdminBiddingCollectionMandateDraft = {
	collectionId: number;
	maxUnitBidEth: string;
};

export type AdminBiddingMandateDraft = {
	collections: AdminBiddingCollectionMandateDraft[];
};

export type AdminBiddingCollectionMandate = AdminBiddingCollectionIdentity & {
	maxUnitBidWei: string;
	maxQuantity: number;
};

export type AdminBiddingWethApprovalPolicy = {
	minPriorityFeePerGasWei: string;
	maxFeePerGasWei: string;
	maxTotalGasFeeWei: string;
	pendingNoncePolicy: EvmPendingNoncePolicy;
};

export type AdminBiddingStartPolicy = {
	wethAllowanceCapWei: string;
	trustOpenSeaSignedZoneTraitOffers: boolean;
	wethApproval: AdminBiddingWethApprovalPolicy;
};

export type AdminBiddingMandate = {
	chainId: number;
	startPolicy: AdminBiddingStartPolicy;
	collections: AdminBiddingCollectionMandate[];
};

export type AdminBotRecord = {
	botKind: AdminBotKind;
	processName: string;
	state: AdminBotState;
	lastError: string | null;
	disabledReason: string | null;
	criticalDependencies: AdminBotCriticalDependency[];
	assignedWallet: AdminBotAssignedWallet | null;
	biddingMandate: AdminBiddingMandate | null;
};

export type AdminBotStateListener = () => void;

export interface AdminBotPort {
	listBots(): Promise<AdminBotRecord[]>;
	loadBiddingCollectionCatalog(): Promise<AdminBiddingCollectionCatalog>;
	assignWallet(botKind: AdminBotKind, walletId: string | null): Promise<AdminBotRecord>;
	startBot(
		botKind: AdminBotKind,
		biddingMandate: AdminBiddingMandateDraft | null
	): Promise<AdminBotRecord>;
	stopBot(botKind: AdminBotKind): Promise<AdminBotRecord>;
	onStateChanged(listener: AdminBotStateListener): Promise<() => void>;
}
