import { withQuery } from '$lib/route-paths';

type ValueOf<T> = T[keyof T];

// Hypercastle subsection ids are owned by the Terraforms extension page route.
export const TERRAFORMS_HYPERCASTLE_SECTIONS = {
	Structure: 'structure',
	OriginsSeedClasses: 'origins-seed-classes'
} as const;

export type TerraformsHypercastleSection = ValueOf<typeof TERRAFORMS_HYPERCASTLE_SECTIONS>;

// DOM contracts for the Hypercastle subsection switcher.
export const TERRAFORMS_HYPERCASTLE_SECTION_DOM = {
	testIds: {
		tabs: 'terraforms-hypercastle-section-tabs'
	}
} as const;

// User-facing labels for the Hypercastle subsection tabs.
export const TERRAFORMS_HYPERCASTLE_SECTION_LABELS = {
	Control: 'view:',
	AriaLabel: 'Hypercastle section',
	Structure: 'Structure',
	OriginsSeedClasses: 'Origins / Seed Classes'
} as const;

// Query parameter names owned by the Terraforms Hypercastle subsection switcher.
export const TERRAFORMS_HYPERCASTLE_SECTION_QUERY_PARAMS = {
	Section: 'section'
} as const;

// Ordered subsection tabs rendered by the Hypercastle top-action chrome.
export const TERRAFORMS_HYPERCASTLE_SECTION_ORDER = [
	TERRAFORMS_HYPERCASTLE_SECTIONS.Structure,
	TERRAFORMS_HYPERCASTLE_SECTIONS.OriginsSeedClasses
] as const;

const TERRAFORMS_HYPERCASTLE_DEFAULT_SECTION = TERRAFORMS_HYPERCASTLE_SECTIONS.Structure;

// Parses route subsection state while falling back to the Structure view.
export function parseTerraformsHypercastleSection(raw: string | null): TerraformsHypercastleSection {
	const value = raw?.trim().toLowerCase();
	return TERRAFORMS_HYPERCASTLE_SECTION_ORDER.includes(value as TerraformsHypercastleSection)
		? (value as TerraformsHypercastleSection)
		: TERRAFORMS_HYPERCASTLE_DEFAULT_SECTION;
}

// Returns the tab label for one Hypercastle subsection id.
export function formatTerraformsHypercastleSectionLabel(
	section: TerraformsHypercastleSection
): string {
	return section === TERRAFORMS_HYPERCASTLE_SECTIONS.OriginsSeedClasses
		? TERRAFORMS_HYPERCASTLE_SECTION_LABELS.OriginsSeedClasses
		: TERRAFORMS_HYPERCASTLE_SECTION_LABELS.Structure;
}

// Builds the current-page href after applying Hypercastle subsection state.
export function buildTerraformsHypercastleSectionHref(
	url: URL,
	section: TerraformsHypercastleSection
): string {
	const query = new URLSearchParams(url.searchParams);
	if (section === TERRAFORMS_HYPERCASTLE_DEFAULT_SECTION) {
		query.delete(TERRAFORMS_HYPERCASTLE_SECTION_QUERY_PARAMS.Section);
	} else {
		query.set(TERRAFORMS_HYPERCASTLE_SECTION_QUERY_PARAMS.Section, section);
	}
	return withQuery(url.pathname, query);
}
