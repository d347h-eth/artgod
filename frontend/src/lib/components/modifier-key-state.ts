import { browser } from '$app/environment';
import { readable } from 'svelte/store';

export type ModifierKeyState = {
	control: boolean;
};

// Exposes currently pressed modifier keys for reusable card affordances.
export const modifierKeyState = readable<ModifierKeyState>({ control: false }, (set) => {
	if (!browser) {
		return;
	}

	function publish(event: KeyboardEvent | FocusEvent): void {
		set({
			control: event instanceof KeyboardEvent ? event.ctrlKey : false
		});
	}

	window.addEventListener('keydown', publish);
	window.addEventListener('keyup', publish);
	window.addEventListener('blur', publish);

	return () => {
		window.removeEventListener('keydown', publish);
		window.removeEventListener('keyup', publish);
		window.removeEventListener('blur', publish);
	};
});
