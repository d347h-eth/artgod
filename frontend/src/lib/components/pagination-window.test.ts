import { describe, expect, it } from 'vitest';
import {
	pageToPaginationWindow,
	refreshPaginationWindowFromHead,
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
			headRequestCursor: null,
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
		expect(resolved.headRequestCursor).toBeNull();
		expect(resolved.headPrevCursor).toBeNull();
		expect(resolved.tailNextCursor).toBe('next-4');
	});

	it('prepends the adjacent previous cursor page without replacing existing items', () => {
		const cached: PaginationWindowState<TestItem> = {
			items: [{ id: '3' }, { id: '4' }],
			rangeStart: 3,
			rangeEnd: 4,
			pagesLoaded: 1,
			headRequestCursor: 'page-3',
			headPrevCursor: 'prev-3',
			tailNextCursor: 'next-4'
		};
		const incoming = pageToPaginationWindow(
			{
				items: [{ id: '1' }, { id: '2' }],
				rangeStart: 1,
				rangeEnd: 2,
				prevCursor: null,
				nextCursor: 'next-2'
			},
			'prev-3'
		);

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
		expect(resolved.headRequestCursor).toBe('prev-3');
		expect(resolved.headPrevCursor).toBeNull();
	});

	it('records the cursor used to load a standalone page', () => {
		const resolved = pageToPaginationWindow(
			{
				items: [{ id: '3' }, { id: '4' }],
				rangeStart: 3,
				rangeEnd: 4,
				prevCursor: 'prev-3',
				nextCursor: 'next-4'
			},
			'page-3'
		);

		expect(resolved.headRequestCursor).toBe('page-3');
	});

	it('refreshes loaded pages from the head cursor with a fresh cursor chain', async () => {
		const requestedCursors: Array<string | null> = [];
		const firstPage = {
			items: [{ id: '5' }, { id: '1' }],
			rangeStart: 1,
			rangeEnd: 2,
			prevCursor: null,
			nextCursor: 'fresh-next-2'
		};
		const secondPage = {
			items: [{ id: '3' }, { id: '4' }],
			rangeStart: 3,
			rangeEnd: 4,
			prevCursor: 'fresh-prev-3',
			nextCursor: 'fresh-next-4'
		};

		const refreshed = await refreshPaginationWindowFromHead({
			pagesLoaded: 2,
			headRequestCursor: null,
			loadPage: async (cursor) => {
				requestedCursors.push(cursor);
				return cursor === null ? firstPage : secondPage;
			},
			pageFromResponse: (response) => response,
			itemKey: (item: TestItem) => item.id
		});

		expect(requestedCursors).toEqual([null, 'fresh-next-2']);
		expect(refreshed.window.items.map((item) => item.id)).toEqual(['5', '1', '3', '4']);
		expect(refreshed.window.headRequestCursor).toBeNull();
		expect(refreshed.window.headPrevCursor).toBeNull();
		expect(refreshed.window.tailNextCursor).toBe('fresh-next-4');
		expect(refreshed.responses).toEqual([firstPage, secondPage]);
	});
});
