import { expect, it, vi } from 'vitest';
import { createSaleMediaLoader, type SaleMedia } from './media';

it('bounds thumbnail concurrency, prioritizes hover, and shares cached previews', async () => {
	const waiting = new Map<string, (value: SaleMedia) => void>();
	const fetch = vi.fn(
		(id: string) => new Promise<SaleMedia>((resolve) => waiting.set(id, resolve))
	);
	const loader = createSaleMediaLoader(fetch);
	const pending = Array.from({ length: 6 }, (_, i) => loader.load(String(i)));
	expect(fetch).toHaveBeenCalledTimes(4);
	expect(loader.load('5', true)).toBe(pending[5]);
	waiting.get('0')!({ tokenId: '0', image: 'image', animationUrl: null });
	await pending[0];
	await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
	expect(fetch.mock.calls[4][0]).toBe('5');
	expect(await loader.load('0')).toEqual({ tokenId: '0', image: 'image', animationUrl: null });
	loader.dispose();
});

it('aborts in-flight requests and releases queued thumbnails on navigation', async () => {
	const signals: AbortSignal[] = [];
	const loader = createSaleMediaLoader(
		(_id, signal) =>
			new Promise((_resolve, reject) => {
				signals.push(signal);
				signal.addEventListener('abort', () => reject(new Error('aborted')));
			})
	);
	const work = Array.from({ length: 10 }, (_, i) => loader.load(String(i)));
	loader.dispose();
	expect(await Promise.all(work)).toEqual(Array(10).fill(null));
	expect(signals).toHaveLength(4);
	expect(signals.every((signal) => signal.aborted)).toBe(true);
	expect(await loader.load('late')).toBeNull();
});
