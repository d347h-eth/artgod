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

export type AdminBiddingCollectionCandidate = {
	chainId: number;
	collectionId: number;
	artgodSlug: string;
	contractAddress: string;
	openseaSlug: string;
	tokenScope: AdminBiddingTokenScopeSummary;
};

export type AdminBiddingCollectionCatalog = {
	chain: AdminBiddingChainIdentity;
	collections: AdminBiddingCollectionCandidate[];
};

export type AdminBiddingCollectionMandateDraft = {
	collectionId: number;
	maxUnitBidEth: string;
	maxQuantity: number;
};

export type AdminBiddingMandateDraft = {
	collections: AdminBiddingCollectionMandateDraft[];
};

export type AdminBiddingCollectionMandate = AdminBiddingCollectionCandidate & {
	maxUnitBidWei: string;
	maxQuantity: number;
};

export type AdminBiddingMandate = {
	chainId: number;
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
