import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { renderTraitSummaryTemplate } from '@artgod/shared/types';
import TraitSummaryTemplateExamples, {
	TEMPLATE_EXAMPLE_TRAITS,
	TRAIT_SUMMARY_TEMPLATE_EXAMPLES
} from './TraitSummaryTemplateExamples.svelte';

describe('trait summary template examples', () => {
	it.each(TRAIT_SUMMARY_TEMPLATE_EXAMPLES)(
		'keeps $template faithful to the current renderer',
		({ template, result }) => {
			expect(renderTraitSummaryTemplate(template, TEMPLATE_EXAMPLE_TRAITS)).toBe(result);
		}
	);

	it('renders literal syntax and real line breaks as a compact reference', () => {
		const { body } = render(TraitSummaryTemplateExamples);
		expect(body).toContain('aria-label="Trait summary template examples"');
		expect(body).toContain('{Color}\n{Shape}');
		expect(body).toContain('{{#if Hat=Cap}}cap{{/if}}');
	});
});
