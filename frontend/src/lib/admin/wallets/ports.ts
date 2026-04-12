export type AdminWalletAction = 'import' | 'export' | 'remove';

export type AdminWalletOverview = {
	configuredWalletCount: number;
	supportedActions: AdminWalletAction[];
	custodyBoundary: 'native_prompt';
};

export interface AdminWalletPort {
	getOverview(): Promise<AdminWalletOverview>;
}
