export type BidBookUpdateFlashKey = string | number | null | undefined;

const BID_BOOK_UPDATE_FLASH_DURATION_MS = 360;
const BID_BOOK_UPDATE_FLASH_EASING = 'ease-out';
const BID_BOOK_UPDATE_FLASH_KEYFRAMES: Keyframe[] = [
	{ backgroundColor: 'transparent' },
	{ backgroundColor: 'var(--bid-book-own-row-background)' }
];

// Replays the bid-book update flash when the supplied refresh key changes.
export function bidBookUpdateFlash(node: HTMLElement, key: BidBookUpdateFlashKey) {
	let currentKey = key;
	let animation: Animation | null = null;

	function replay(nextKey: BidBookUpdateFlashKey): void {
		if (nextKey === null || nextKey === undefined || typeof node.animate !== 'function') {
			return;
		}
		animation?.cancel();
		animation = node.animate(BID_BOOK_UPDATE_FLASH_KEYFRAMES, {
			duration: BID_BOOK_UPDATE_FLASH_DURATION_MS,
			easing: BID_BOOK_UPDATE_FLASH_EASING
		});
	}

	return {
		update(nextKey: BidBookUpdateFlashKey) {
			if (nextKey === currentKey) {
				return;
			}
			currentKey = nextKey;
			replay(nextKey);
		},
		destroy() {
			animation?.cancel();
		}
	};
}
