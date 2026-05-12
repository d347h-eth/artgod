// Describes opt-in token-card selection state without coupling cards to a feature.
export type TokenCardSelectionState = {
	selected: boolean;
	disabled?: boolean;
	title?: string | null;
};

// Names the card gestures that feature-specific controllers may map to selection.
export type TokenCardSelectionGesture = 'ctrl_left_click' | 'middle_click' | 'remove_button';

// Carries a token-card selection request from reusable card UI to feature state.
export type TokenCardSelectionToggleRequest = {
	tokenId: string;
	gesture: TokenCardSelectionGesture;
	selected: boolean;
};

// Reusable token-card selection props should be passed only by pages that opt in.
export type TokenCardSelectionProps = {
	state: TokenCardSelectionState;
	onToggle: (request: TokenCardSelectionToggleRequest) => void;
};
