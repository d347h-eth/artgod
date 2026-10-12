import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import BidBookTraitList from './BidBookTraitList.svelte';

describe('bid-book trait label navigation', () => {
	it.each([
		{ type: 'Palette', value: 'Red,Blue' },
		{ type: 'Trait,Kind', value: 'Rare' },
		{ type: 'Trait:Kind', value: 'Rare' }
	])('keeps unsafe trait text visible without calling the navigation callback: %j', (trait) => {
		const href = vi.fn(() => '/test-trait');
		const { body } = render(BidBookTraitList, { props: { traits: [trait], traitValueHref: href } });
		expect(body).toContain(trait.type);
		expect(body).toContain(trait.value);
		expect(body).not.toContain('href=');
		expect(href).not.toHaveBeenCalled();
	});
	it.each([
		{ type: 'Palette', value: 'Red:Blue' },
		{ type: 'Art & Édition/%+?#', value: 'Rare + 50% & /? # 🟦' }
	])('retains safe trait-label navigation with the original identity: %j', (trait) => {
		const href = vi.fn(() => '/test-trait');
		const { body } = render(BidBookTraitList, { props: { traits: [trait], traitValueHref: href } });
		expect(body).toContain('href="/test-trait"');
		expect(href).toHaveBeenCalledExactlyOnceWith({ key: trait.type, value: trait.value });
	});
});
