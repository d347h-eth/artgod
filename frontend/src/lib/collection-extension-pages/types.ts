import type { Component } from 'svelte';
import type { ApiChain, ApiCollection, ApiCollectionMediaState } from '$lib/api-types';

// Stable page ref identifies an extension-owned collection page.
export type CollectionExtensionPageRef = {
	extensionKey: string;
	pageRef: string;
};

// Generic context passed from the core collection page route into extension pages.
export type CollectionExtensionPageProps = {
	chain: ApiChain;
	collection: ApiCollection;
	media: ApiCollectionMediaState;
	basePath: string;
	page: CollectionExtensionPageRef;
};

// Registration binds an extension page id to the component that renders it.
export type CollectionExtensionPageRegistration = CollectionExtensionPageRef & {
	label: string;
	Page: Component<CollectionExtensionPageProps>;
};

// Registry port lets bundled and future runtime-loaded extensions publish pages.
export type CollectionExtensionPageRegistrar = {
	registerCollectionExtensionPage: (registration: CollectionExtensionPageRegistration) => void;
};
