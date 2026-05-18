import { get, writable, type Readable } from 'svelte/store';
import {
	BIDDING_AUTOMATION_FILTER_SELECTION_STATE,
	BIDDING_AUTOMATION_FILTER_TARGET_INTENT,
	BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE,
	type BiddingAutomationSelectedBidSelection,
	type BiddingAutomationFilterTargetIntent,
	type BiddingAutomationSelection,
	type BiddingAutomationTokenFilterSnapshot
} from '$lib/bidding-automation';
import { TRADING_BIDDING_BID_SCOPE_KIND } from '@artgod/shared/types';
import type {
	TokenCardSelectionGesture,
	TokenCardSelectionState,
	TokenCardSelectionToggleRequest
} from '$lib/token-card-selection';

export type BiddingAutomationControllerState = {
	selection: BiddingAutomationSelection | null;
};

export type SelectFilteredTokensInput = {
	targetIntent: BiddingAutomationFilterTargetIntent;
	filter: BiddingAutomationTokenFilterSnapshot;
	tokenCount: number;
};

export type ToggleBiddingTokenInput = TokenCardSelectionToggleRequest & {
	visibleTokenIds: string[];
};

export type BiddingAutomationController = {
	state: Readable<BiddingAutomationControllerState>;
	selectFilteredTokens(input: SelectFilteredTokensInput): void;
	selectExplicitTokens(tokenIds: string[]): void;
	selectBid(selection: Omit<BiddingAutomationSelectedBidSelection, 'type'>): void;
	toggleToken(input: ToggleBiddingTokenInput): void;
	clearSelection(): void;
	isTokenSelected(tokenId: string): boolean;
	tokenSelectionState(tokenId: string): TokenCardSelectionState;
	selectionSummary(): string | null;
};

// Builds the shared controller input for exact trait-job targets backed by the current filter.
export function buildFilteredTraitBiddingSelectionInput(params: {
	filter: BiddingAutomationTokenFilterSnapshot;
	tokenCount: number;
}): SelectFilteredTokensInput {
	return {
		targetIntent: BIDDING_AUTOMATION_FILTER_TARGET_INTENT.TraitJob,
		filter: params.filter,
		tokenCount: params.tokenCount
	};
}

// Builds the shared controller input for all-matching-token batch targets.
export function buildFilteredTokenBatchBiddingSelectionInput(params: {
	filter: BiddingAutomationTokenFilterSnapshot;
	tokenCount: number;
}): SelectFilteredTokensInput {
	return {
		targetIntent: BIDDING_AUTOMATION_FILTER_TARGET_INTENT.TokenBatch,
		filter: params.filter,
		tokenCount: params.tokenCount
	};
}

// Identifies the broad "all filtered tokens" state before optional visible-page refinement.
export function isCleanFilteredTokenBatchSelection(
	selection: BiddingAutomationSelection | null
): boolean {
	return (
		selection?.type === BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens &&
		selection.targetIntent === BIDDING_AUTOMATION_FILTER_TARGET_INTENT.TokenBatch &&
		selection.state.kind === BIDDING_AUTOMATION_FILTER_SELECTION_STATE.Clean
	);
}

export function createBiddingAutomationController(): BiddingAutomationController {
	const state = writable<BiddingAutomationControllerState>({
		selection: null
	});

	function selectFilteredTokens(input: SelectFilteredTokensInput): void {
		state.set({
			selection: {
				type: BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens,
				targetIntent: input.targetIntent,
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

	function selectExplicitTokens(tokenIds: string[]): void {
		state.set({
			selection: tokenIds.length > 0
				? {
						type: BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.ExplicitTokens,
						tokenIds
					}
				: null
		});
	}

	function selectBid(selection: Omit<BiddingAutomationSelectedBidSelection, 'type'>): void {
		state.set({
			selection: {
				type: BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.SelectedBid,
				...selection
			}
		});
	}

	function clearSelection(): void {
		state.set({ selection: null });
	}

	function isTokenSelected(tokenId: string): boolean {
		return isBiddingAutomationTokenSelected(get(state).selection, tokenId);
	}

	function tokenSelectionState(tokenId: string): TokenCardSelectionState {
		return biddingAutomationTokenSelectionState(get(state).selection, tokenId);
	}

	function selectionSummary(): string | null {
		return describeBiddingAutomationSelection(get(state).selection);
	}

	return {
		state: { subscribe: state.subscribe },
		selectFilteredTokens,
		selectExplicitTokens,
		selectBid,
		toggleToken,
		clearSelection,
		isTokenSelected,
		tokenSelectionState,
		selectionSummary
	};
}

// Describes the current selection without reading from a Svelte store.
export function describeBiddingAutomationSelection(
	selection: BiddingAutomationSelection | null
): string | null {
	if (!selection) return null;
	if (selection.type === BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens) {
		if (selection.targetIntent === BIDDING_AUTOMATION_FILTER_TARGET_INTENT.TraitJob) {
			const count = selection.filter.selectedTraits.length;
			return count === 1 ? '1 trait selected' : `${count} traits selected`;
		}
		if (selection.state.kind === BIDDING_AUTOMATION_FILTER_SELECTION_STATE.Clean) {
			return `${selection.tokenCount} tokens selected`;
		}
		const count = selection.state.visibleTokenIds.length;
		return count === 1 ? '1 token selected' : `${count} tokens selected`;
	}
	if (selection.type === BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.ExplicitTokens) {
		const count = selection.tokenIds.length;
		return count === 1 ? '1 token selected' : `${count} tokens selected`;
	}
	if (selection.bid.scope.kind === TRADING_BIDDING_BID_SCOPE_KIND.Trait) {
		const count = selection.bid.scope.traits.length;
		return count === 1 ? '1 trait selected' : `${count} traits selected`;
	}
	if (selection.bid.scope.kind === TRADING_BIDDING_BID_SCOPE_KIND.Token) {
		return '1 token selected';
	}
	if (selection.bid.scope.kind === TRADING_BIDDING_BID_SCOPE_KIND.Collection) {
		return 'collection selected';
	}
	return 'bid selected';
}

// Provides a stable render dependency for selection-state functions passed through component props.
export function biddingAutomationSelectionStateKey(
	selection: BiddingAutomationSelection | null
): string {
	if (!selection) return 'none';
	if (selection.type === BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.ExplicitTokens) {
		return `explicit:${selection.tokenIds.join('\u0000')}`;
	}
	if (selection.type === BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.SelectedBid) {
		return `bid:${selection.bid.orderId}:${selection.existingJob?.jobId ?? 'new'}`;
	}
	if (selection.state.kind === BIDDING_AUTOMATION_FILTER_SELECTION_STATE.Clean) {
		return [
			'filter-clean',
			selection.targetIntent,
			selection.filter.source,
			selection.tokenCount,
			selection.filter.tokenStatus ?? 'any-status',
			selection.filter.makerAddress ?? 'any-maker',
			selection.filter.traitJoinMode,
			...selection.filter.selectedTraits.map((trait) => `${trait.key}=${trait.value}`),
			...selection.filter.selectedTraitRanges.map(
				(range) => `${range.key}:${range.fromValue ?? ''}:${range.toValue ?? ''}`
			)
		].join('|');
	}
	return `filter-visible:${selection.state.visibleTokenIds.join('\u0000')}`;
}

// Resolves one token's selected state from an explicit selection snapshot.
export function biddingAutomationTokenSelectionState(
	selection: BiddingAutomationSelection | null,
	tokenId: string,
	_stateKey: string = biddingAutomationSelectionStateKey(selection)
): TokenCardSelectionState {
	return {
		selected: isBiddingAutomationTokenSelected(selection, tokenId)
	};
}

// Treats clean filtered selections as selecting every visible card in the active view.
export function isBiddingAutomationTokenSelected(
	selection: BiddingAutomationSelection | null,
	tokenId: string
): boolean {
	if (!selection) return false;
	if (selection.type === BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.ExplicitTokens) {
		return selection.tokenIds.includes(tokenId);
	}
	if (selection.type === BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens) {
		if (selection.targetIntent !== BIDDING_AUTOMATION_FILTER_TARGET_INTENT.TokenBatch) {
			return false;
		}
		if (selection.state.kind === BIDDING_AUTOMATION_FILTER_SELECTION_STATE.Clean) {
			return true;
		}
		return selection.state.visibleTokenIds.includes(tokenId);
	}
	return false;
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
		if (selection.targetIntent !== BIDDING_AUTOMATION_FILTER_TARGET_INTENT.TokenBatch) {
			return new Set();
		}
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
	// Preserve native browser new-tab gestures on token-card links.
	if (isNativeLinkActivationTarget(event.target)) {
		return null;
	}
	if (event.type === 'click' && event.button === 0 && event.ctrlKey) {
		return 'ctrl_left_click';
	}
	if (event.type === 'auxclick' && event.button === 1) {
		return 'middle_click';
	}
	return null;
}

function isNativeLinkActivationTarget(target: EventTarget | null): boolean {
	const closestTarget = closestCapableTarget(target);
	return closestTarget?.closest('a[href]') != null;
}

function closestCapableTarget(
	target: EventTarget | null
): { closest: (selector: string) => unknown } | null {
	if (!target) {
		return null;
	}
	const maybeElement = target as {
		closest?: (selector: string) => unknown;
		parentElement?: { closest?: (selector: string) => unknown } | null;
	};
	if (typeof maybeElement.closest === 'function') {
		return { closest: maybeElement.closest.bind(maybeElement) };
	}
	if (typeof maybeElement.parentElement?.closest === 'function') {
		return { closest: maybeElement.parentElement.closest.bind(maybeElement.parentElement) };
	}
	return null;
}
