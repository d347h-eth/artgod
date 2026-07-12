// Owns collection-cap labels and security explanations shared across the Bots flow.
export const BIDDING_AUTHORIZATION_CAP_COPY = {
	maxUnitBid: {
		label: 'max WETH for any one NFT',
		help: 'Safety limit for every signed offer. ArtGod rejects an offer when its total WETH exceeds this amount multiplied by its NFT quantity. This bounds the price for each NFT, not combined WETH across separate offers.'
	},
	maxQuantity: {
		label: 'max NFTs per offer',
		help: "Safety limit for every signed offer. ArtGod currently fixes this to 1 NFT, so it rejects any unexpected multi-NFT offer. With one NFT, the WETH limit above is also the offer's total limit."
	}
} as const;
