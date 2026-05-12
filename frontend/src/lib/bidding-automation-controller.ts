import { get, writable, type Readable } from 'svelte/store';
import {
	BIDDING_AUTOMATION_FILTER_SELECTION_STATE,
	BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE,
	type BiddingAutomationSelection,
	type BiddingAutomationTokenFilterSnapshot
} from '$lib/bidding-automation';
import type {
	TokenCardSelectionGesture,
	TokenCardSelectionState,
	TokenCardSelectionToggleRequest
} from '$lib/token-card-selection';

export type BiddingAutomationControllerState = {
	selection: BiddingAutomationSelection | null;
};

export type SelectFilteredTokensInput = {
	filter: BiddingAutomationTokenFilterSnapshot;
	tokenCount: number;
};

export type ToggleBiddingTokenInput = TokenCardSelectionToggleRequest & {
	visibleTokenIds: string[];
};

export type BiddingAutomationController = {
	state: Readable<BiddingAutomationControllerState>;
	selectFilteredTokens(input: SelectFilteredTokensInput): void;
	toggleToken(input: ToggleBiddingTokenInput): void;
	clearSelection(): void;
	isTokenSelected(tokenId: string): boolean;
	tokenSelectionState(tokenId: string): TokenCardSelectionState;
	selectionSummary(): string | null;
};

export function createBiddingAutomationController(): BiddingAutomationController {
	const state = writable<BiddingAutomationControllerState>({
		selection: null
	});

	function selectFilteredTokens(input: SelectFilteredTokensInput): void {
		state.set({
			selection: {
				type: BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens,
				filter: input.filter,
				tokenCount: input.tokenCount,
				state: {
					kind: BIDDING_AUTOMATION_FILTER_SELECTION_STATE.Clean
				}
			}
		});
	}

	function toggleToken(input: ToggleBiddingTokenInput): void {
		state.update((current) => ({
			selection: nextSelectionAfterTokenToggle(current.selection, input)
		}));
	}

	function clearSelection(): void {
		state.set({ selection: null });
	}

	function isTokenSelected(tokenId: string): boolean {
		return selectedTokenIds(get(state).selection).has(tokenId);
	}

	function tokenSelectionState(tokenId: string): TokenCardSelectionState {
		return {
			selected: isTokenSelected(tokenId)
		};
	}

	function selectionSummary(): string | null {
		const selection = get(state).selection;
		if (!selection) return null;
		if (selection.type === BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens) {
			if (selection.state.kind === BIDDING_AUTOMATION_FILTER_SELECTION_STATE.Clean) {
				return `${selection.tokenCount} selected`;
			}
			const count = selection.state.visibleTokenIds.length;
			return count === 1 ? '1 selected' : `${count} selected`;
		}
		if (selection.type === BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.ExplicitTokens) {
			const count = selection.tokenIds.length;
			return count === 1 ? '1 selected' : `${count} selected`;
		}
		return 'bid selected';
	}

	return {
		state: { subscribe: state.subscribe },
		selectFilteredTokens,
		toggleToken,
		clearSelection,
		isTokenSelected,
		tokenSelectionState,
		selectionSummary
	};
}

function nextSelectionAfterTokenToggle(
	selection: BiddingAutomationSelection | null,
	input: ToggleBiddingTokenInput
): BiddingAutomationSelection | null {
	const nextTokenIds = selectedTokenIds(selection, input.visibleTokenIds);
	if (input.selected) {
		nextTokenIds.add(input.tokenId);
	} else {
		nextTokenIds.delete(input.tokenId);
	}
	const ordered = input.visibleTokenIds.filter((tokenId) => nextTokenIds.has(tokenId));
	for (const tokenId of nextTokenIds) {
		if (!ordered.includes(tokenId)) {
			ordered.push(tokenId);
		}
	}
	if (ordered.length === 0) {
		return null;
	}
	return {
		type: BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.ExplicitTokens,
		tokenIds: ordered
	};
}

function selectedTokenIds(
	selection: BiddingAutomationSelection | null,
	visibleTokenIds: string[] = []
): Set<string> {
	if (!selection) {
		return new Set();
	}
	if (selection.type === BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.ExplicitTokens) {
		return new Set(selection.tokenIds);
	}
	if (selection.type === BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens) {
		if (selection.state.kind === BIDDING_AUTOMATION_FILTER_SELECTION_STATE.Clean) {
			return new Set(visibleTokenIds);
		}
		return new Set(selection.state.visibleTokenIds);
	}
	return new Set();
}

// Maps DOM mouse state into the supported token-card selection gestures.
export function resolveTokenCardSelectionGesture(
	event: MouseEvent
): TokenCardSelectionGesture | null {
	if (event.type === 'click' && event.button === 0 && event.ctrlKey) {
		return 'ctrl_left_click';
	}
	if (event.type === 'auxclick' && event.button === 1) {
		return 'middle_click';
	}
	return null;
}
