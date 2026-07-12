// Central registry for frontend localStorage keys; keep key literals searchable here only.
export const LOCAL_STORAGE_KEYS = {
	// Remembers the last selected bidding bid-book scope globally.
	collectionBiddingNavigationPreferences: 'artgod.collectionBidding.navigationPreferences.v1',
	// Remembers whether the reusable trait facet panel is collapsed.
	traitFacetPanelCollapsed: 'artgod.traitFacetPanel.collapsed',
	// Remembers the token preview modal zoom/scale percentage.
	tokenPreviewScalePercent: 'artgod.tokenBrowser.previewScalePercent',
	// Remembers that the mobile preview swipe hint has been dismissed.
	tokenPreviewSwipeHintDismissed: 'artgod.tokenPreview.swipeHintDismissed'
} as const;

// Serialized booleans shared by compact localStorage-backed UI preferences.
export const LOCAL_STORAGE_BOOLEAN_VALUES = {
	False: '0',
	True: '1'
} as const;
