import type { Component } from 'svelte';
import type {
	ApiActivityEventMedia,
	ApiActivityExtensionEventFeed,
	ApiActivityExtensionEventRef,
	ApiActivityFeedItem,
	ApiTokenPresentationSummary
} from '$lib/api-types';

// Canonical generic activity table columns that extension views may reuse or replace.
export const ACTIVITY_TABLE_COLUMN_IDS = {
	Id: 'id',
	Price: 'price',
	Media: 'media',
	Name: 'name',
	Traits: 'traits',
	From: 'from',
	To: 'to',
	Content: 'content',
	Time: 'time'
} as const;

// Built-in column ids known by the generic activity table renderer.
export type ActivityTableColumnId =
	(typeof ACTIVITY_TABLE_COLUMN_IDS)[keyof typeof ACTIVITY_TABLE_COLUMN_IDS];

// Column keys allow extensions to append custom cells without changing the generic id union.
export type ActivityTableColumnKey = ActivityTableColumnId | (string & {});

// URL-backed filter values shared between the generic activity page and extension filters.
export type ActivityExtensionFilterValues = {
	tokenId: string | null;
	maker: string | null;
	contentHash: string | null;
	eventGroup: string | null;
};

// Partial filter patches let extension controls update one filter without owning route state.
export type ActivityExtensionFilterPatch = Partial<ActivityExtensionFilterValues>;

// Link builders give extension cells generic navigation without importing app route helpers.
export type ActivityExtensionCellHrefs = {
	filter: (filters: ActivityExtensionFilterPatch) => string;
	blockExplorerAddress: (address: string | null) => string | null;
	holder: (address: string) => string;
	tokenDetail: (tokenId: string) => string;
};

// Row context passed from the generic activity table into extension-owned cell components.
export type ActivityExtensionCellProps = {
	activity: ApiActivityFeedItem;
	token: ApiTokenPresentationSummary | null;
	eventMedia: ApiActivityEventMedia | null;
	hrefs: ActivityExtensionCellHrefs;
};

// Filter context passed from the generic activity page into extension-owned filter components.
export type ActivityExtensionFiltersProps = {
	chainRef: string;
	feed: ApiActivityExtensionEventFeed;
	filters: ActivityExtensionFilterValues;
	onApply: (filters: ActivityExtensionFilterPatch) => void | Promise<void>;
};

// Table column definitions let extensions compose built-in columns with custom renderers.
export type ActivityTableColumn = {
	id: ActivityTableColumnKey;
	label?: string;
	Cell?: Component<ActivityExtensionCellProps>;
	mono?: boolean;
};

// Feed view metadata describes the extension-owned table and filter customizations.
export type ActivityExtensionEventView = {
	columns?: readonly ActivityTableColumn[];
	Filters?: Component<ActivityExtensionFiltersProps>;
};

// Registration payload binds one extension event feed to the frontend view it owns.
export type ActivityExtensionEventViewRegistration = {
	extensionKey: string;
	eventKey: string;
	view: ActivityExtensionEventView;
};

// Registry port lets embedded and future runtime-loaded extensions publish activity views.
export type ActivityExtensionEventViewRegistrar = {
	registerActivityExtensionEventView: (
		registration: ActivityExtensionEventViewRegistration
	) => void;
};

// Resolvers keep collection-specific activity view selection outside the generic table shell.
export type ActivityExtensionEventViewResolver = (
	event: ApiActivityExtensionEventRef
) => ActivityExtensionEventView | null;
