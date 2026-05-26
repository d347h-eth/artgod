import type {
	CollectionExtensionPageRef,
	CollectionExtensionPageRegistrar,
	CollectionExtensionPageRegistration
} from '$lib/collection-extension-pages/types';

const collectionExtensionPagesByKey = new Map<string, CollectionExtensionPageRegistration>();

// Registers or replaces an extension-owned collection page.
export function registerCollectionExtensionPage(
	registration: CollectionExtensionPageRegistration
): void {
	collectionExtensionPagesByKey.set(extensionPageKey(registration), registration);
}

// Registrar object is the stable API surface passed to extension activation modules.
export const collectionExtensionPageRegistrar: CollectionExtensionPageRegistrar = {
	registerCollectionExtensionPage
};

// Resolves a registered extension page for the generic extension page route.
export function resolveCollectionExtensionPage(
	page: CollectionExtensionPageRef
): CollectionExtensionPageRegistration | null {
	return collectionExtensionPagesByKey.get(extensionPageKey(page)) ?? null;
}

// Checks page availability without exposing registry internals to navigation code.
export function hasCollectionExtensionPage(page: CollectionExtensionPageRef): boolean {
	return collectionExtensionPagesByKey.has(extensionPageKey(page));
}

function extensionPageKey(page: CollectionExtensionPageRef): string {
	return `${page.extensionKey}:${page.pageRef}`;
}

export type {
	CollectionExtensionPageActionScope,
	CollectionExtensionPageProps,
	CollectionExtensionPageRef,
	CollectionExtensionPageRegistration,
	CollectionExtensionPageRegistrar
} from '$lib/collection-extension-pages/types';
