export type AdminBotKind = 'bidding' | 'sniping';
export type AdminBotState =
	| 'disabled'
	| 'locked'
	| 'awaiting_unlock'
	| 'starting'
	| 'bootstrapping'
	| 'running'
	| 'stopped'
	| 'error';

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

export type AdminBotRecord = {
	botKind: AdminBotKind;
	processName: string;
	state: AdminBotState;
	lastError: string | null;
	criticalDependencies: AdminBotCriticalDependency[];
	assignedWallet: AdminBotAssignedWallet | null;
};

export type AdminBotStateListener = () => void;

export interface AdminBotPort {
	listBots(): Promise<AdminBotRecord[]>;
	assignWallet(botKind: AdminBotKind, walletId: string | null): Promise<AdminBotRecord>;
	startBot(botKind: AdminBotKind): Promise<AdminBotRecord>;
	stopBot(botKind: AdminBotKind): Promise<AdminBotRecord>;
	onStateChanged(listener: AdminBotStateListener): Promise<() => void>;
}
