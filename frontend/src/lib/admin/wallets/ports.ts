export type AdminWalletAction = 'import' | 'export' | 'remove';

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

export type AdminWalletExportResult =
	| {
			outcome: 'revealed';
			wallet: AdminWalletRecord;
	  }
	| {
			outcome: 'cancelled';
	  };

export interface AdminWalletPort {
	getStatus(): Promise<AdminWalletStatus>;
	listWallets(): Promise<AdminWalletRecord[]>;
	importWallet(): Promise<AdminWalletImportResult>;
	exportWallet(walletId: string): Promise<AdminWalletExportResult>;
	removeWallet(walletId: string): Promise<AdminWalletRemoveResult>;
}
