import type { Component } from 'svelte';
import type { ApiChain, ApiCollection, ApiCollectionMediaState } from '$lib/api-types';

// Stable page ref identifies an extension-owned collection page.
export type CollectionExtensionPageRef = {
	extensionKey: string;
	pageRef: string;
};

// Page-local actions let extension top-action chrome invoke extension body behavior.
export type CollectionExtensionPageActionScope = {
	registerAction: (key: string, handler: () => void) => () => void;
	runAction: (key: string) => void;
};

// Generic context passed from the core collection page route into extension pages.
export type CollectionExtensionPageProps = {
	chain: ApiChain;
	collection: ApiCollection;
	media: ApiCollectionMediaState;
	basePath: string;
	page: CollectionExtensionPageRef;
	actions: CollectionExtensionPageActionScope;
};

// Registration binds an extension page id to the component that renders it.
export type CollectionExtensionPageRegistration = CollectionExtensionPageRef & {
	label: string;
	Page: Component<CollectionExtensionPageProps>;
	// TopActions renders row-level chrome inside the collection page top-action stack.
	TopActions?: Component<CollectionExtensionPageProps>;
};

// Registry port lets bundled and future runtime-loaded extensions publish pages.
export type CollectionExtensionPageRegistrar = {
	registerCollectionExtensionPage: (registration: CollectionExtensionPageRegistration) => void;
};
