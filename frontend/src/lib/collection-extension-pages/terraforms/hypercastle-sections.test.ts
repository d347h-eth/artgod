import { describe, expect, it } from 'vitest';
import {
	buildTerraformsHypercastleSectionHref,
	formatTerraformsHypercastleSectionLabel,
	parseTerraformsHypercastleSection,
	TERRAFORMS_HYPERCASTLE_SECTION_LABELS,
	TERRAFORMS_HYPERCASTLE_SECTION_QUERY_PARAMS,
	TERRAFORMS_HYPERCASTLE_SECTIONS
} from '$lib/collection-extension-pages/terraforms/hypercastle-sections';
import { TERRAFORMS_HYPERCASTLE_SELECTION_QUERY_PARAMS } from '$lib/collection-extension-pages/terraforms/hypercastle-selection';

const TEST_HYPERCASTLE_URL = new URL(
	'https://artgod.local/ethereum/terraforms/extensions/terraforms/hypercastle'
);
const TEST_HYPERCASTLE_LEVEL_VALUE = '12';
TEST_HYPERCASTLE_URL.searchParams.set(
	TERRAFORMS_HYPERCASTLE_SELECTION_QUERY_PARAMS.Level,
	TEST_HYPERCASTLE_LEVEL_VALUE
);

describe('Terraforms Hypercastle sections', () => {
	it('parses unknown section routes as the default Structure section', () => {
		expect(parseTerraformsHypercastleSection(null)).toBe(TERRAFORMS_HYPERCASTLE_SECTIONS.Structure);
		expect(parseTerraformsHypercastleSection('nope')).toBe(
			TERRAFORMS_HYPERCASTLE_SECTIONS.Structure
		);
		expect(parseTerraformsHypercastleSection(TERRAFORMS_HYPERCASTLE_SECTIONS.OriginsSeedClasses)).toBe(
			TERRAFORMS_HYPERCASTLE_SECTIONS.OriginsSeedClasses
		);
	});

	it('builds section links while omitting the default Structure query value', () => {
		const originsHref = buildTerraformsHypercastleSectionHref(
			TEST_HYPERCASTLE_URL,
			TERRAFORMS_HYPERCASTLE_SECTIONS.OriginsSeedClasses
		);
		const originsUrl = new URL(originsHref, TEST_HYPERCASTLE_URL);

		expect(originsUrl.searchParams.get(TERRAFORMS_HYPERCASTLE_SECTION_QUERY_PARAMS.Section)).toBe(
			TERRAFORMS_HYPERCASTLE_SECTIONS.OriginsSeedClasses
		);
		expect(
			originsUrl.searchParams.get(TERRAFORMS_HYPERCASTLE_SELECTION_QUERY_PARAMS.Level)
		).toBe(TEST_HYPERCASTLE_LEVEL_VALUE);

		const structureHref = buildTerraformsHypercastleSectionHref(
			originsUrl,
			TERRAFORMS_HYPERCASTLE_SECTIONS.Structure
		);
		const structureUrl = new URL(structureHref, TEST_HYPERCASTLE_URL);

		expect(structureUrl.searchParams.get(TERRAFORMS_HYPERCASTLE_SECTION_QUERY_PARAMS.Section)).toBeNull();
		expect(
			structureUrl.searchParams.get(TERRAFORMS_HYPERCASTLE_SELECTION_QUERY_PARAMS.Level)
		).toBe(TEST_HYPERCASTLE_LEVEL_VALUE);
	});

	it('formats section tab labels from the owned label contract', () => {
		expect(formatTerraformsHypercastleSectionLabel(TERRAFORMS_HYPERCASTLE_SECTIONS.Structure)).toBe(
			TERRAFORMS_HYPERCASTLE_SECTION_LABELS.Structure
		);
		expect(
			formatTerraformsHypercastleSectionLabel(
				TERRAFORMS_HYPERCASTLE_SECTIONS.OriginsSeedClasses
			)
		).toBe(TERRAFORMS_HYPERCASTLE_SECTION_LABELS.OriginsSeedClasses);
	});
});
