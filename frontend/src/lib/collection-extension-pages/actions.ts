import type { CollectionExtensionPageActionScope } from '$lib/collection-extension-pages/types';

const COLLECTION_EXTENSION_PAGE_ACTION_ERRORS = {
	missingAction: 'collection extension page action is not registered'
} as const;

// Creates a page-local command bus shared by extension top actions and page bodies.
export function createCollectionExtensionPageActionScope(): CollectionExtensionPageActionScope {
	const handlers = new Map<string, () => void>();

	return {
		registerAction(key, handler) {
			handlers.set(key, handler);
			return () => {
				if (handlers.get(key) === handler) {
					handlers.delete(key);
				}
			};
		},
		runAction(key) {
			const handler = handlers.get(key);
			if (!handler) {
				throw new Error(COLLECTION_EXTENSION_PAGE_ACTION_ERRORS.missingAction);
			}
			handler();
		}
	};
}
