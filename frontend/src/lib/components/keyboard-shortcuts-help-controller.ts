import { get, writable, type Readable } from 'svelte/store';

export type KeyboardShortcutsHelpState = {
	open: boolean;
};

export type KeyboardShortcutsHelpController = {
	state: Readable<KeyboardShortcutsHelpState>;
	open(): void;
	close(): void;
	toggle(): void;
	onWindowKeydown(event: KeyboardEvent): void;
};

export function createKeyboardShortcutsHelpController(): KeyboardShortcutsHelpController {
	const state = writable<KeyboardShortcutsHelpState>({
		open: false
	});

	function open(): void {
		state.set({ open: true });
	}

	function close(): void {
		state.set({ open: false });
	}

	function toggle(): void {
		state.set({ open: !get(state).open });
	}

	function onWindowKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented) return;

		if (event.key === 'F1') {
			event.preventDefault();
			toggle();
			return;
		}

		if (!get(state).open) return;

		if (event.key === 'Escape') {
			event.preventDefault();
			close();
		}
	}

	return {
		state: { subscribe: state.subscribe },
		open,
		close,
		toggle,
		onWindowKeydown
	};
}
