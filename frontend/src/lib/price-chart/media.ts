import type { getTokenPreview } from '$lib/backend-api';

export type SaleMedia = Awaited<ReturnType<typeof getTokenPreview>>['token'];
export type SalePreviewTarget = { tokenId: string; x: number; y: number; count: number };
const MAX_CONCURRENT = 4;
const MAX_CACHED = 256;
const MAX_QUEUED = 100;

/** One bounded snapshot cache shared by row thumbnails and the ephemeral preview.
 * Hover requests move ahead of queued thumbnails; navigation aborts all work. */
export function createSaleMediaLoader(
	fetchMedia: (tokenId: string, signal: AbortSignal) => Promise<SaleMedia>
) {
	const cache = new Map<string, SaleMedia>();
	const pending = new Map<string, Promise<SaleMedia | null>>();
	const queue: { tokenId: string; resolve: (media: SaleMedia | null) => void }[] = [];
	const abort = new AbortController();
	let active = 0;
	function pump() {
		while (!abort.signal.aborted && active < MAX_CONCURRENT && queue.length) {
			const job = queue.shift()!;
			active++;
			void fetchMedia(job.tokenId, abort.signal)
				.then((media) => {
					if (abort.signal.aborted) return job.resolve(null);
					cache.set(job.tokenId, media);
					if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
					job.resolve(media);
				})
				.catch(() => job.resolve(null))
				.finally(() => {
					active--;
					pending.delete(job.tokenId);
					pump();
				});
		}
	}
	return {
		load(tokenId: string, priority = false): Promise<SaleMedia | null> {
			if (abort.signal.aborted) return Promise.resolve(null);
			const cached = cache.get(tokenId);
			if (cached) return Promise.resolve(cached);
			const existing = pending.get(tokenId);
			if (existing) {
				const i = queue.findIndex((job) => job.tokenId === tokenId);
				if (priority && i > 0) queue.unshift(...queue.splice(i, 1));
				return existing;
			}
			if (queue.length >= MAX_QUEUED) {
				const dropped = queue.pop()!;
				pending.delete(dropped.tokenId);
				dropped.resolve(null);
			}
			const promise = new Promise<SaleMedia | null>((resolve) => {
				const job = { tokenId, resolve };
				if (priority) queue.unshift(job);
				else queue.push(job);
			});
			pending.set(tokenId, promise);
			pump();
			return promise;
		},
		dispose() {
			abort.abort();
			for (const job of queue.splice(0)) job.resolve(null);
			pending.clear();
			cache.clear();
		}
	};
}
export type SaleMediaLoader = ReturnType<typeof createSaleMediaLoader>;
