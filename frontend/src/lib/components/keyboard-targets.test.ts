import { describe, expect, it } from 'vitest';
import { isKeyboardTextEntryTarget } from './keyboard-targets';

describe('isKeyboardTextEntryTarget', () => {
	it('treats text-entry elements as hotkey-blocking targets', () => {
		expect(isKeyboardTextEntryTarget(elementLike('INPUT', 'text'))).toBe(true);
		expect(isKeyboardTextEntryTarget(elementLike('TEXTAREA'))).toBe(true);
		expect(isKeyboardTextEntryTarget(elementLike('SELECT'))).toBe(true);
		expect(
			isKeyboardTextEntryTarget(
				{ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget
			)
		).toBe(true);
	});

	it('can keep checkbox and radio focus hotkey-active for filter controls', () => {
		expect(isKeyboardTextEntryTarget(elementLike('INPUT', 'checkbox'))).toBe(true);
		expect(
			isKeyboardTextEntryTarget(elementLike('INPUT', 'checkbox'), {
				allowCheckboxAndRadio: true
			})
		).toBe(false);
		expect(
			isKeyboardTextEntryTarget(elementLike('INPUT', 'radio'), {
				allowCheckboxAndRadio: true
			})
		).toBe(false);
	});
});

function elementLike(tagName: string, type?: string): EventTarget {
	return { tagName, type } as unknown as EventTarget;
}
