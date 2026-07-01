// Shared pricing-mode vocabulary for bidding automation UI and Playwright harnesses.
export const BIDDING_AUTOMATION_PRICING_MODE = {
	Manual: 'manual',
	Tier: 'tier'
} as const;

export type BiddingAutomationPricingMode =
	(typeof BIDDING_AUTOMATION_PRICING_MODE)[keyof typeof BIDDING_AUTOMATION_PRICING_MODE];

// User-facing labels for bidding automation pricing-mode controls.
export const BIDDING_AUTOMATION_PRICING_MODE_LABEL = {
	[BIDDING_AUTOMATION_PRICING_MODE.Manual]: 'manual',
	[BIDDING_AUTOMATION_PRICING_MODE.Tier]: 'tier'
} as const;
