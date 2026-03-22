import { browser } from '$app/environment';
import { get, writable, type Readable } from 'svelte/store';

const TRAIT_PANEL_COLLAPSED_STORAGE_KEY = 'artgod.traitFacetPanel.collapsed';
const LEGACY_TRAIT_PANEL_COLLAPSED_STORAGE_KEY = 'artgod.tokenBrowser.traitsCollapsed';
const TRAIT_PANEL_COLLAPSED_ROOT_CLASS = 'trait-facet-panel-collapsed';

export type TraitFacetPanelState = {
	collapsed: boolean;
};

export type TraitFacetPanelController = {
	state: Readable<TraitFacetPanelState>;
	toggle(): void;
	setCollapsed(collapsed: boolean): void;
	onWindowKeydown(event: KeyboardEvent): void;
};

export function createTraitFacetPanelController(): TraitFacetPanelController {
	const initialCollapsed = readInitialCollapsed();
	const state = writable<TraitFacetPanelState>({
		collapsed: initialCollapsed
	});

	syncCollapsedPreference(initialCollapsed);

	function setCollapsed(collapsed: boolean): void {
		syncCollapsedPreference(collapsed);
		state.set({ collapsed });
	}

	function toggle(): void {
		setCollapsed(!get(state).collapsed);
	}

	function onWindowKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented) return;
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.key.toLowerCase() !== 't') return;
		if (isTypingTarget(event.target)) return;
		event.preventDefault();
		toggle();
	}

	return {
		state: { subscribe: state.subscribe },
		toggle,
		setCollapsed,
		onWindowKeydown
	};
}

function readInitialCollapsed(): boolean {
	if (!browser) return false;
	try {
		if (document.documentElement.classList.contains(TRAIT_PANEL_COLLAPSED_ROOT_CLASS)) {
			return true;
		}
		return (
			window.localStorage.getItem(TRAIT_PANEL_COLLAPSED_STORAGE_KEY) === '1' ||
			window.localStorage.getItem(LEGACY_TRAIT_PANEL_COLLAPSED_STORAGE_KEY) === '1'
		);
	} catch {
		return false;
	}
}

function syncCollapsedPreference(collapsed: boolean): void {
	if (!browser) return;
	try {
		window.localStorage.setItem(TRAIT_PANEL_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
		window.localStorage.removeItem(LEGACY_TRAIT_PANEL_COLLAPSED_STORAGE_KEY);
	} catch {
		// Ignore storage failures and keep the in-memory state.
	}
	document.documentElement.classList.toggle(TRAIT_PANEL_COLLAPSED_ROOT_CLASS, collapsed);
}

function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	const tag = target.tagName.toLowerCase();
	return tag === 'input' || tag === 'textarea' || tag === 'select';
}
