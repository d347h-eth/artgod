<script module lang="ts">
	// Keep the illustrative results checked against the shared template renderer.
	export const TEMPLATE_EXAMPLE_TRAITS = [
		{ key: 'Color', value: 'Blue' },
		{ key: 'Shape', value: 'Circle' },
		{ key: 'Hat', value: 'Cap' }
	];
	export const TRAIT_SUMMARY_TEMPLATE_EXAMPLES = [
		{ template: '{Color}', result: 'Blue' },
		{ template: 'color: {Color} / {Shape}', result: 'color: Blue / Circle' },
		{ template: '{Color}\n{Shape}', result: 'Blue\nCircle' },
		{ template: '{{#if Hat}}hat: {Hat}{{/if}}', result: 'hat: Cap' },
		{ template: '{{#if Hat=Cap}}cap{{/if}}', result: 'cap' },
		{ template: '{Missing}', result: null }
	];
</script>

<table class="customization-template-examples" aria-label="Trait summary template examples">
	<caption>
		examples: <code>{TEMPLATE_EXAMPLE_TRAITS.map(({ key, value }) => `${key}=${value}`).join(', ')}</code>
	</caption>
	<thead><tr><th>template</th><th>result</th></tr></thead>
	<tbody>
		{#each TRAIT_SUMMARY_TEMPLATE_EXAMPLES as example}
			<tr>
				<td><code>{example.template}</code></td>
				<td>
					{#if example.result !== null}
						<code>{example.result}</code>
					{:else}
						<span class="muted">empty</span>
					{/if}
				</td>
			</tr>
		{/each}
	</tbody>
</table>
