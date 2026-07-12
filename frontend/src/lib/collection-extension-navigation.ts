import type {
	ApiActivityExtensionEventFeed,
	ApiActivityExtensionEventRef,
	ApiCollectionExtensionSummary
} from '$lib/api-types';
import {
	hasCollectionExtensionPage,
	type CollectionExtensionPageRef
} from '$lib/collection-extension-pages';

// Navigation target kinds keep extension tab behavior explicit and extensible.
export const COLLECTION_EXTENSION_NAVIGATION_TAB_TARGET_KIND = {
	ActivityExtensionEvent: 'activity-extension-event',
	ExtensionPage: 'extension-page'
} as const;

// Activity event targets route to the generic collection activity page with an extension event ref.
export type CollectionExtensionNavigationActivityEventTarget = {
	kind: typeof COLLECTION_EXTENSION_NAVIGATION_TAB_TARGET_KIND.ActivityExtensionEvent;
	event: ApiActivityExtensionEventRef;
};

// Extension page targets route to a generic collection extension page host.
export type CollectionExtensionNavigationPageTarget = CollectionExtensionPageRef & {
	kind: typeof COLLECTION_EXTENSION_NAVIGATION_TAB_TARGET_KIND.ExtensionPage;
};

// Extension navigation targets can grow with collection-page route targets later.
export type CollectionExtensionNavigationTabTarget =
	| CollectionExtensionNavigationActivityEventTarget
	| CollectionExtensionNavigationPageTarget;

// Extension tabs describe a label and a core-resolvable navigation target.
export type CollectionExtensionNavigationTab = {
	id: string;
	label: string;
	target: CollectionExtensionNavigationTabTarget;
};

// Extension groups define where extension-owned tabs are presented in collection navigation.
export type CollectionExtensionNavigationGroupRegistration = {
	id: string;
	label: string;
	order?: number;
	tabs: readonly CollectionExtensionNavigationTab[];
};

// Resolved extension groups contain only tabs available for the current collection.
export type CollectionExtensionNavigationGroup = {
	id: string;
	label: string;
	tabs: readonly CollectionExtensionNavigationTab[];
};

// Registry port lets embedded and future runtime-loaded extensions publish collection navigation.
export type CollectionExtensionNavigationRegistrar = {
	registerCollectionNavigationGroup: (
		registration: CollectionExtensionNavigationGroupRegistration
	) => void;
};

type RegisteredCollectionExtensionNavigationGroup =
	CollectionExtensionNavigationGroupRegistration & {
		registrationIndex: number;
	};

const COLLECTION_EXTENSION_NAVIGATION_DEFAULT_ORDER = 1000;
let nextRegistrationIndex = 0;
const collectionNavigationGroupsById = new Map<
	string,
	RegisteredCollectionExtensionNavigationGroup
>();

// Registers or replaces an extension-owned collection navigation group.
export function registerCollectionNavigationGroup(
	registration: CollectionExtensionNavigationGroupRegistration
): void {
	const existing = collectionNavigationGroupsById.get(registration.id);
	collectionNavigationGroupsById.set(registration.id, {
		...registration,
		tabs: [...registration.tabs],
		registrationIndex: existing?.registrationIndex ?? nextRegistrationIndex++
	});
}

// Registrar object is the stable API surface passed to extension activation modules.
export const collectionExtensionNavigationRegistrar: CollectionExtensionNavigationRegistrar = {
	registerCollectionNavigationGroup
};

// Resolves extension navigation groups for feeds currently enabled on the collection.
export function resolveCollectionExtensionNavigationGroups(input: {
	activityEventFeeds: readonly ApiActivityExtensionEventFeed[];
	collectionExtensions?: readonly ApiCollectionExtensionSummary[];
}): CollectionExtensionNavigationGroup[] {
	const availableActivityEvents = new Set(input.activityEventFeeds.map(activityEventKey));
	const availableExtensions = new Set(
		input.collectionExtensions?.map((extension) => extension.key) ?? []
	);
	return [...collectionNavigationGroupsById.values()]
		.sort(compareNavigationGroups)
		.map((group) => ({
			id: group.id,
			label: group.label,
			tabs: group.tabs.filter((tab) =>
				tabIsAvailable(tab, availableActivityEvents, availableExtensions)
			)
		}))
		.filter((group) => group.tabs.length > 0);
}

// Extracts an activity event target when a generic renderer needs built-in route semantics.
export function collectionExtensionNavigationTabActivityEvent(
	tab: CollectionExtensionNavigationTab
): ApiActivityExtensionEventRef | null {
	switch (tab.target.kind) {
		case COLLECTION_EXTENSION_NAVIGATION_TAB_TARGET_KIND.ActivityExtensionEvent:
			return tab.target.event;
		case COLLECTION_EXTENSION_NAVIGATION_TAB_TARGET_KIND.ExtensionPage:
			return null;
	}
}

// Extracts an extension page target when a generic renderer needs route semantics.
export function collectionExtensionNavigationTabPage(
	tab: CollectionExtensionNavigationTab
): CollectionExtensionNavigationPageTarget | null {
	switch (tab.target.kind) {
		case COLLECTION_EXTENSION_NAVIGATION_TAB_TARGET_KIND.ExtensionPage:
			return tab.target;
		case COLLECTION_EXTENSION_NAVIGATION_TAB_TARGET_KIND.ActivityExtensionEvent:
			return null;
	}
}

function tabIsAvailable(
	tab: CollectionExtensionNavigationTab,
	availableActivityEvents: ReadonlySet<string>,
	availableExtensions: ReadonlySet<string>
): boolean {
	switch (tab.target.kind) {
		case COLLECTION_EXTENSION_NAVIGATION_TAB_TARGET_KIND.ActivityExtensionEvent:
			return availableActivityEvents.has(activityEventKey(tab.target.event));
		case COLLECTION_EXTENSION_NAVIGATION_TAB_TARGET_KIND.ExtensionPage:
			return (
				availableExtensions.has(tab.target.extensionKey) && hasCollectionExtensionPage(tab.target)
			);
	}
}

function compareNavigationGroups(
	left: RegisteredCollectionExtensionNavigationGroup,
	right: RegisteredCollectionExtensionNavigationGroup
): number {
	const orderCompare =
		(left.order ?? COLLECTION_EXTENSION_NAVIGATION_DEFAULT_ORDER) -
		(right.order ?? COLLECTION_EXTENSION_NAVIGATION_DEFAULT_ORDER);
	if (orderCompare !== 0) return orderCompare;
	return left.registrationIndex - right.registrationIndex;
}

// Extension event keys are internal registry ids, not user-facing URLs.
function activityEventKey(event: ApiActivityExtensionEventRef): string {
	return `${event.extensionKey}:${event.eventKey}`;
}
