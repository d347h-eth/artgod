export type AdminWalletAction = 'import' | 'remove';

export type AdminWalletBotKind = 'bidding' | 'sniping';
export type AdminWalletStoredStatus = 'stored';

export type AdminWalletStatus = {
	configuredWalletCount: number;
	supportedActions: AdminWalletAction[];
	custodyBoundary: 'native_prompt';
};

export type AdminWalletRecord = {
	walletId: string;
	label: string;
	address: string;
	assignedBotKinds: AdminWalletBotKind[];
	status: AdminWalletStoredStatus;
};

export type AdminWalletImportResult =
	| {
			outcome: 'imported';
			wallet: AdminWalletRecord;
	  }
	| {
			outcome: 'cancelled';
	  };

export type AdminWalletRemoveResult =
	| {
			outcome: 'removed';
			wallet: AdminWalletRecord;
	  }
	| {
			outcome: 'cancelled';
	  };

export interface AdminWalletPort {
	getStatus(): Promise<AdminWalletStatus>;
	listWallets(): Promise<AdminWalletRecord[]>;
	importWallet(): Promise<AdminWalletImportResult>;
	removeWallet(walletId: string): Promise<AdminWalletRemoveResult>;
}
