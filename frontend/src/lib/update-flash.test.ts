import { describe, expect, it, vi } from 'vitest';
import { UPDATE_FLASH_MODE, updateFlash } from '$lib/update-flash';
import { bidBookUpdateFlash } from '$lib/bid-book-update-flash';

describe('shared update flash', () => {
	it('flashes new suggestions once and replaces the animation only when the value changes', () => {
		const cancel = vi.fn();
		const animate = vi.fn(() => ({ cancel }));
		const node = { animate } as unknown as HTMLElement;
		const action = updateFlash(node, { key: 'image', playOnMount: true });
		expect(animate).toHaveBeenCalledTimes(1);
		action.update({ key: 'image', playOnMount: true });
		expect(animate).toHaveBeenCalledTimes(1);
		action.update({ key: 'image_url', playOnMount: true });
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(animate).toHaveBeenCalledTimes(2);
		action.destroy();
		expect(cancel).toHaveBeenCalledTimes(2);
	});

	it('preserves bid-book refresh behavior through the same implementation', () => {
		expect(bidBookUpdateFlash).toBe(updateFlash);
		const animate = vi.fn(() => ({ cancel: vi.fn() }));
		const node = { animate } as unknown as HTMLElement;
		const action = bidBookUpdateFlash(node, { key: 1, mode: UPDATE_FLASH_MODE.Transient });
		expect(animate).not.toHaveBeenCalled();
		action.update({ key: 2, mode: UPDATE_FLASH_MODE.Transient });
		expect(animate).toHaveBeenCalledOnce();
		action.destroy();
	});
});
