import type { TradingCompetitionPreset } from '@artgod/shared/types';

// One inventory load supplies both the preset editor and every trait-job picker.
// Editor writes and trait-choice loads have their own errors.
export type BiddingCompetitionPresetInventory = {
	presets: TradingCompetitionPreset[];
	loading: boolean;
	error: string | null;
	refresh: () => Promise<void>;
};
