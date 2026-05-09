import {
	TERRAFORMS_EXTENSION_EVENT_KEYS,
	TERRAFORMS_EXTENSION_KEY
} from '@artgod/shared/extensions/terraforms';
import {
	ACTIVITY_TABLE_COLUMN_IDS,
	type ActivityExtensionEventView,
	type ActivityExtensionEventViewRegistrar
} from '$lib/activity-extension-views/types';
import {
	COLLECTION_EXTENSION_NAVIGATION_TAB_TARGET_KIND,
	type CollectionExtensionNavigationRegistrar
} from '$lib/collection-extension-navigation';
import {
	TERRAFORMS_ACTIVITY_EVENT_NAVIGATION_GROUP_IDS,
	TERRAFORMS_ACTIVITY_EVENT_NAVIGATION_GROUP_LABELS,
	TERRAFORMS_ACTIVITY_EVENT_NAVIGATION_TAB_IDS,
	TERRAFORMS_ACTIVITY_EVENT_NAVIGATION_TAB_LABELS,
	TERRAFORMS_BEACON_COLUMN_IDS,
	TERRAFORMS_BEACON_COLUMN_LABELS
} from '$lib/activity-extension-views/terraforms/constants';
import TerraformsBeaconActionCell from '$lib/activity-extension-views/terraforms/TerraformsBeaconActionCell.svelte';
import TerraformsBeaconContentCell from '$lib/activity-extension-views/terraforms/TerraformsBeaconContentCell.svelte';
import TerraformsBeaconFilters from '$lib/activity-extension-views/terraforms/TerraformsBeaconFilters.svelte';
import TerraformsDreamsFilters from '$lib/activity-extension-views/terraforms/TerraformsDreamsFilters.svelte';
import TerraformsHeightmapCell from '$lib/activity-extension-views/terraforms/TerraformsHeightmapCell.svelte';
import TerraformsMakerCell from '$lib/activity-extension-views/terraforms/TerraformsMakerCell.svelte';
import TerraformsTokenIdCell from '$lib/activity-extension-views/terraforms/TerraformsTokenIdCell.svelte';

// Terraforms owns only the event-specific heightmap column label.
const TERRAFORMS_DREAMS_COLUMN_LABELS = {
	Heightmap: 'heightmap'
} as const;

// Terraforms dreams view composes generic activity columns with Terraforms-owned cells.
const TERRAFORMS_DREAMS_ACTIVITY_VIEW: ActivityExtensionEventView = {
	columns: [
		{ id: ACTIVITY_TABLE_COLUMN_IDS.Media },
		{ id: ACTIVITY_TABLE_COLUMN_IDS.Id, Cell: TerraformsTokenIdCell },
		{ id: ACTIVITY_TABLE_COLUMN_IDS.Name },
		{ id: ACTIVITY_TABLE_COLUMN_IDS.Traits },
		{ id: ACTIVITY_TABLE_COLUMN_IDS.From, Cell: TerraformsMakerCell },
		{
			id: ACTIVITY_TABLE_COLUMN_IDS.Content,
			label: TERRAFORMS_DREAMS_COLUMN_LABELS.Heightmap,
			Cell: TerraformsHeightmapCell
		},
		{ id: ACTIVITY_TABLE_COLUMN_IDS.Time }
	],
	Filters: TerraformsDreamsFilters
};

// Terraforms beacon view handles mixed token-scoped and Mathcastles admin rows.
const TERRAFORMS_BEACON_ACTIVITY_VIEW: ActivityExtensionEventView = {
	columns: [
		{ id: ACTIVITY_TABLE_COLUMN_IDS.Media },
		{ id: ACTIVITY_TABLE_COLUMN_IDS.Id, Cell: TerraformsTokenIdCell },
		{ id: ACTIVITY_TABLE_COLUMN_IDS.Name },
		{ id: ACTIVITY_TABLE_COLUMN_IDS.Traits },
		{ id: ACTIVITY_TABLE_COLUMN_IDS.From, Cell: TerraformsMakerCell },
		{
			id: TERRAFORMS_BEACON_COLUMN_IDS.Action,
			label: TERRAFORMS_BEACON_COLUMN_LABELS.Action,
			Cell: TerraformsBeaconActionCell,
			mono: true
		},
		{
			id: ACTIVITY_TABLE_COLUMN_IDS.Content,
			label: TERRAFORMS_BEACON_COLUMN_LABELS.Details,
			Cell: TerraformsBeaconContentCell,
			mono: true
		},
		{ id: ACTIVITY_TABLE_COLUMN_IDS.Time }
	],
	Filters: TerraformsBeaconFilters
};

// Registers Terraforms activity feed views through the generic frontend extension port.
export function registerTerraformsActivityExtensionViews(
	registrar: ActivityExtensionEventViewRegistrar
): void {
	registrar.registerActivityExtensionEventView({
		extensionKey: TERRAFORMS_EXTENSION_KEY,
		eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Terraformed,
		view: TERRAFORMS_DREAMS_ACTIVITY_VIEW
	});
	registrar.registerActivityExtensionEventView({
		extensionKey: TERRAFORMS_EXTENSION_KEY,
		eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Beacon,
		view: TERRAFORMS_BEACON_ACTIVITY_VIEW
	});
}

// Registers Terraforms collection navigation groups through the generic frontend extension port.
export function registerTerraformsCollectionNavigation(
	registrar: CollectionExtensionNavigationRegistrar
): void {
	registrar.registerCollectionNavigationGroup({
		id: TERRAFORMS_ACTIVITY_EVENT_NAVIGATION_GROUP_IDS.CollectionEvents,
		label: TERRAFORMS_ACTIVITY_EVENT_NAVIGATION_GROUP_LABELS.CollectionEvents,
		tabs: [
			{
				id: TERRAFORMS_ACTIVITY_EVENT_NAVIGATION_TAB_IDS.Dreams,
				label: TERRAFORMS_ACTIVITY_EVENT_NAVIGATION_TAB_LABELS.Dreams,
				target: {
					kind: COLLECTION_EXTENSION_NAVIGATION_TAB_TARGET_KIND.ActivityExtensionEvent,
					event: {
						extensionKey: TERRAFORMS_EXTENSION_KEY,
						eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Terraformed
					}
				}
			},
			{
				id: TERRAFORMS_ACTIVITY_EVENT_NAVIGATION_TAB_IDS.Beacon,
				label: TERRAFORMS_ACTIVITY_EVENT_NAVIGATION_TAB_LABELS.Beacon,
				target: {
					kind: COLLECTION_EXTENSION_NAVIGATION_TAB_TARGET_KIND.ActivityExtensionEvent,
					event: {
						extensionKey: TERRAFORMS_EXTENSION_KEY,
						eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Beacon
					}
				}
			}
		]
	});
}
