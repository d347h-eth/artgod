import { get } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import { createTraitFacetPanelController } from './trait-facet-panel-controller';

describe('trait facet panel controller', () => {
	it('uses F, not T, for the panel toggle hotkey', () => {
		const controller = createTraitFacetPanelController();
		controller.setCollapsed(true);

		controller.onWindowKeydown(keyEvent('t'));
		expect(get(controller.state).collapsed).toBe(true);

		controller.onWindowKeydown(keyEvent('f'));
		expect(get(controller.state).collapsed).toBe(false);
	});

	it('keeps hotkeys active after a trait checkbox receives focus', () => {
		const controller = createTraitFacetPanelController();
		const onReset = vi.fn();

		const checkbox = { tagName: 'INPUT', type: 'checkbox' } as unknown as EventTarget;
		const resetEvent = keyEvent('r', checkbox);
		controller.onWindowKeydown(resetEvent, { onReset });

		expect(onReset).toHaveBeenCalledTimes(1);
	});

	it('delegates F to a page-specific toggle action when provided', () => {
		const controller = createTraitFacetPanelController();
		const onToggle = vi.fn();
		controller.setCollapsed(true);

		controller.onWindowKeydown(keyEvent('f'), { onToggle });

		expect(onToggle).toHaveBeenCalledTimes(1);
		expect(get(controller.state).collapsed).toBe(true);
	});
});

function keyEvent(key: string, target: EventTarget | null = null): KeyboardEvent {
	const event = {
		key,
		defaultPrevented: false,
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		target,
		preventDefault() {
			event.defaultPrevented = true;
		}
	};
	return event as KeyboardEvent;
}
