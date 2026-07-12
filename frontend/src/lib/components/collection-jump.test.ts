import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
import { resolveCollectionJumpHref } from './collection-jump';

const { resolveOwnerRefMock } = vi.hoisted(() => ({
	resolveOwnerRefMock: vi.fn()
}));

vi.mock('$lib/backend-api', () => ({
	resolveOwnerRef: resolveOwnerRefMock
}));

describe('resolveCollectionJumpHref', () => {
	beforeEach(() => {
		resolveOwnerRefMock.mockReset();
	});

	it('keeps token id jumps local', async () => {
		await expect(
			resolveCollectionJumpHref({
				fetchFn: fetch,
				chainRef: 'ethereum',
				basePath: '/ethereum/terraforms',
				mediaMode: COLLECTION_MEDIA_MODES.Snapshot,
				value: '5081'
			})
		).resolves.toBe('/ethereum/terraforms/5081?media_mode=snapshot');
		expect(resolveOwnerRefMock).not.toHaveBeenCalled();
	});

	it('keeps raw owner jumps local and normalizes casing', async () => {
		await expect(
			resolveCollectionJumpHref({
				fetchFn: fetch,
				chainRef: 'ethereum',
				basePath: '/ethereum/terraforms',
				mediaMode: COLLECTION_MEDIA_MODES.Snapshot,
				value: '0xAbCDEFabcdefABCDEFabcdefabcdefABCDEFabcd'
			})
		).resolves.toBe(
			'/ethereum/terraforms/holders/0xabcdefabcdefabcdefabcdefabcdefabcdefabcd?limit=250&mode=grid&token_status=listed_then_unlisted&media_mode=snapshot'
		);
		expect(resolveOwnerRefMock).not.toHaveBeenCalled();
	});

	it('resolves .eth owner jumps through the backend', async () => {
		resolveOwnerRefMock.mockResolvedValue({
			input: 'vitalik.eth',
			resolvedAddress: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'
		});

		await expect(
			resolveCollectionJumpHref({
				fetchFn: fetch,
				chainRef: 'ethereum',
				basePath: '/ethereum/terraforms',
				mediaMode: COLLECTION_MEDIA_MODES.Snapshot,
				value: 'vitalik.eth'
			})
		).resolves.toBe(
			'/ethereum/terraforms/holders/0xd8da6bf26964af9d7eed9e03e53415d37aa96045?limit=250&mode=grid&token_status=listed_then_unlisted&media_mode=snapshot'
		);
		expect(resolveOwnerRefMock).toHaveBeenCalledWith(fetch, 'ethereum', 'vitalik.eth');
	});

	it('ignores unsupported owner refs', async () => {
		await expect(
			resolveCollectionJumpHref({
				fetchFn: fetch,
				chainRef: 'ethereum',
				basePath: '/ethereum/terraforms',
				mediaMode: COLLECTION_MEDIA_MODES.Snapshot,
				value: 'not-an-owner'
			})
		).resolves.toBeNull();
		expect(resolveOwnerRefMock).not.toHaveBeenCalled();
	});
});
