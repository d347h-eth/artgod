import { getContext, setContext } from 'svelte';
import type { CollectionViewPage } from '$lib/collection-view';

const key = Symbol('collection view');
type ReadCollectionView = () => CollectionViewPage | null | undefined;
export function provideCollectionView(read: ReadCollectionView): void {
	setContext(key, read);
}
export function useCollectionView(): ReadCollectionView {
	return getContext<ReadCollectionView | undefined>(key) ?? (() => null);
}
