import type {
	ActivityExtensionEventView,
	ActivityExtensionEventViewRegistrar,
	ActivityExtensionEventViewRegistration,
	ActivityExtensionEventViewResolver
} from '$lib/activity-extension-views/types';

// Mutable registry is the frontend port for embedded and future runtime-loaded extension views.
const activityExtensionEventViewsByExtension = new Map<
	string,
	Map<string, ActivityExtensionEventView>
>();

// Registers or replaces the frontend view for a specific collection extension event feed.
export function registerActivityExtensionEventView(
	registration: ActivityExtensionEventViewRegistration
): void {
	const extensionViews =
		activityExtensionEventViewsByExtension.get(registration.extensionKey) ?? new Map();
	extensionViews.set(registration.eventKey, registration.view);
	activityExtensionEventViewsByExtension.set(registration.extensionKey, extensionViews);
}

// Registrar object is the stable API surface passed to extension activation modules.
export const activityExtensionEventViewRegistrar: ActivityExtensionEventViewRegistrar = {
	registerActivityExtensionEventView
};

// Resolves collection-extension-owned activity feed UI without leaking extension rules into the table.
export const resolveActivityExtensionEventView: ActivityExtensionEventViewResolver = (
	event
): ActivityExtensionEventView | null => {
	return activityExtensionEventViewsByExtension.get(event.extensionKey)?.get(event.eventKey) ?? null;
};
