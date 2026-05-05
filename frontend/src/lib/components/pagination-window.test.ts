import { describe, expect, it } from 'vitest';
import {
	pageToPaginationWindow,
	resolvePaginationWindow,
	type PaginationWindowState
} from '$lib/components/pagination-window';

type TestItem = {
	id: string;
};

describe('resolvePaginationWindow', () => {
	it('appends the adjacent next cursor page without replacing existing items', () => {
		const cached: PaginationWindowState<TestItem> = {
			items: [{ id: '1' }, { id: '2' }],
			rangeStart: 1,
			rangeEnd: 2,
			pagesLoaded: 1,
			headPrevCursor: null,
			tailNextCursor: 'next-2'
		};
		const incoming = pageToPaginationWindow({
			items: [{ id: '3' }, { id: '4' }],
			rangeStart: 3,
			rangeEnd: 4,
			prevCursor: 'prev-3',
			nextCursor: 'next-4'
		});

		const resolved = resolvePaginationWindow({
			cached,
			incoming,
			requestCursor: 'next-2',
			itemKey: (item) => item.id
		});

		expect(resolved.items.map((item) => item.id)).toEqual(['1', '2', '3', '4']);
		expect(resolved.rangeStart).toBe(1);
		expect(resolved.rangeEnd).toBe(4);
		expect(resolved.pagesLoaded).toBe(2);
		expect(resolved.tailNextCursor).toBe('next-4');
	});

	it('prepends the adjacent previous cursor page without replacing existing items', () => {
		const cached: PaginationWindowState<TestItem> = {
			items: [{ id: '3' }, { id: '4' }],
			rangeStart: 3,
			rangeEnd: 4,
			pagesLoaded: 1,
			headPrevCursor: 'prev-3',
			tailNextCursor: 'next-4'
		};
		const incoming = pageToPaginationWindow({
			items: [{ id: '1' }, { id: '2' }],
			rangeStart: 1,
			rangeEnd: 2,
			prevCursor: null,
			nextCursor: 'next-2'
		});

		const resolved = resolvePaginationWindow({
			cached,
			incoming,
			requestCursor: 'prev-3',
			itemKey: (item) => item.id
		});

		expect(resolved.items.map((item) => item.id)).toEqual(['1', '2', '3', '4']);
		expect(resolved.rangeStart).toBe(1);
		expect(resolved.rangeEnd).toBe(4);
		expect(resolved.pagesLoaded).toBe(2);
		expect(resolved.headPrevCursor).toBeNull();
	});
});
