import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { APP_VERSION } from '$lib/runtime/app-version';
import KeyboardShortcutsHelp from './KeyboardShortcutsHelp.svelte';
import { createKeyboardShortcutsHelpController } from '$lib/components/keyboard-shortcuts-help-controller';

describe('KeyboardShortcutsHelp', () => {
	it('renders the help trigger button', () => {
		const keyboardShortcutsHelp = createKeyboardShortcutsHelpController();
		const { body } = render(KeyboardShortcutsHelp, {
			props: {
				keyboardShortcutsHelp
			}
		});

		expect(body).toContain('aria-label="keyboard shortcuts"');
		expect(body).toContain('>?<');
	});

	it('renders the shortcuts modal content when open', () => {
		const keyboardShortcutsHelp = createKeyboardShortcutsHelpController();
		keyboardShortcutsHelp.open();

		const { body } = render(KeyboardShortcutsHelp, {
			props: {
				keyboardShortcutsHelp
			}
		});

		expect(body).toContain('keyboard shortcuts');
		expect(body).toContain('Token Browser Preview Navigation');
		expect(body).toContain('Collection Navigation');
		expect(body).toContain('Bidding');
		expect(body).toContain(APP_VERSION);
		expect(body).toContain('artgod.network');
		expect(body).toContain('x.com/artgod_eth');
		expect(body).toContain('>F1<');
		expect(body).toContain('>1<');
		expect(body).toContain('open asks');
		expect(body).not.toContain('>4<');
		expect(body).not.toContain('open bidding');
		expect(body).toContain('>Ctrl+LMB<');
		expect(body).toContain('>MMB<');
		expect(body).toContain('append or remove token card from bidding selection');
		expect(body).toContain('>Ctrl+Alt+LMB<');
		expect(body).toContain('>Alt+MMB<');
		expect(body).toContain('select only this token card for bidding');
		expect(body).toContain('>S<');
		expect(body).toContain('cycle bid scope');
		expect(body).toContain('>T<');
		expect(body).toContain('toggle tiers management');
		expect(body).toContain('>B<');
		expect(body).toContain('hide or show the bidding panel');
		expect(body).toContain('>C<');
		expect(body).toContain('clear the current bidding target');
		expect(body).not.toContain('>Esc<');
		expect(body).not.toContain('cycle bidding view');
		expect(body.indexOf('decrease preview height')).toBeLessThan(
			body.indexOf('increase preview height')
		);
	});
});
