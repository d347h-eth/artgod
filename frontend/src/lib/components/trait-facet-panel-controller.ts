import { browser } from '$app/environment';
import { get, writable, type Readable } from 'svelte/store';
import { isKeyboardTextEntryTarget } from '$lib/components/keyboard-targets';

const TRAIT_PANEL_COLLAPSED_STORAGE_KEY = 'artgod.traitFacetPanel.collapsed';
const TRAIT_PANEL_COLLAPSED_ROOT_CLASS = 'trait-facet-panel-collapsed';

type MaybePromise<T> = T | Promise<T>;

type TraitFacetPanelHotkeys = {
	onToggle?: () => MaybePromise<void>;
	onReset?: () => MaybePromise<void>;
};

export type TraitFacetPanelState = {
	collapsed: boolean;
};

export type TraitFacetPanelController = {
	state: Readable<TraitFacetPanelState>;
	toggle(): void;
	setCollapsed(collapsed: boolean): void;
	onWindowKeydown(event: KeyboardEvent, hotkeys?: TraitFacetPanelHotkeys): void;
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

	function onWindowKeydown(event: KeyboardEvent, hotkeys: TraitFacetPanelHotkeys = {}): void {
		if (event.defaultPrevented) return;
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (isKeyboardTextEntryTarget(event.target, { allowCheckboxAndRadio: true })) return;

		const key = event.key.toLowerCase();
		if (key === 'f') {
			event.preventDefault();
			if (hotkeys.onToggle) {
				void hotkeys.onToggle();
			} else {
				toggle();
			}
			return;
		}

		if (key === 'r' && hotkeys.onReset) {
			event.preventDefault();
			void hotkeys.onReset();
		}
	}

	return {
		state: { subscribe: state.subscribe },
		toggle,
		setCollapsed,
		onWindowKeydown
	};
}

function readInitialCollapsed(): boolean {
	if (!browser) return true;
	try {
		if (document.documentElement.classList.contains(TRAIT_PANEL_COLLAPSED_ROOT_CLASS)) {
			return true;
		}
		const stored = window.localStorage.getItem(TRAIT_PANEL_COLLAPSED_STORAGE_KEY);
		if (stored === null) return true;
		return stored === '1';
	} catch {
		return true;
	}
}

function syncCollapsedPreference(collapsed: boolean): void {
	if (!browser) return;
	try {
		window.localStorage.setItem(TRAIT_PANEL_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
	} catch {
		// Ignore storage failures and keep the in-memory state.
	}
	document.documentElement.classList.toggle(TRAIT_PANEL_COLLAPSED_ROOT_CLASS, collapsed);
}
