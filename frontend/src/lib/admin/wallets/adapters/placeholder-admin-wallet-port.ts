import type { AdminWalletOverview, AdminWalletPort } from '../ports';

const PLACEHOLDER_WALLET_OVERVIEW: AdminWalletOverview = {
	configuredWalletCount: 0,
	supportedActions: ['import', 'export', 'remove'],
	custodyBoundary: 'native_prompt'
};

export function createPlaceholderAdminWalletPort(): AdminWalletPort {
	return {
		async getOverview(): Promise<AdminWalletOverview> {
			return PLACEHOLDER_WALLET_OVERVIEW;
		}
	};
}
