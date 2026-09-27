import { describe, expect, it } from 'vitest';
import {
	buildJsonPreviewDocument,
	JSON_PREVIEW_THEME_PROPERTIES,
	type JsonPreviewTheme
} from './json-preview';

const theme = Object.fromEntries(
	JSON_PREVIEW_THEME_PROPERTIES.map((key) => [key, 'currentColor'])
) as JsonPreviewTheme;
describe('inert JSON preview', () => {
	it('escapes markup in keys and values instead of creating executable content', () => {
		const html = buildJsonPreviewDocument(
			JSON.stringify({
				'</code><script>parent.alert(1)</script>': '<img src="https://attacker.example/">'
			}),
			theme
		);
		expect(html).not.toContain('<script>');
		expect(html).not.toContain('<img');
		expect(html).toContain('&lt;script&gt;');
		expect(html).toContain("default-src 'none'");
	});
	it('masks long keys and values while retaining their complete text', () => {
		const key = 'k'.repeat(1_000),
			value = 'A'.repeat(60_000);
		const html = buildJsonPreviewDocument(JSON.stringify({ [key]: value }), theme);
		expect(html.match(/<details /g)).toHaveLength(2);
		expect(html).toContain(value);
		expect(html).toContain('60,002 characters');
	});
	it('retains unreadable responses for inspection', () => {
		const html = buildJsonPreviewDocument('<html>gateway error</html>', theme);
		expect(html).toContain('Response is not valid JSON');
		expect(html).toContain('&lt;html&gt;gateway error&lt;/html&gt;');
	});
	it('bounds tree rendering for deep or wide documents', () => {
		for (const text of [
			'['.repeat(1_000) + '0' + ']'.repeat(1_000),
			JSON.stringify(Array(10_000).fill(1))
		]) {
			const html = buildJsonPreviewDocument(text, theme);
			expect(html).toContain('Large document');
			expect(html.match(/<details /g)).toHaveLength(1);
		}
	});
});
