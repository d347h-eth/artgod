import { escapeHtml } from '$lib/html';

// Text stays in a script-free iframe. Bounds limit pretty-printing depth and DOM size;
// unusually complex documents remain available as collapsed original response text.
export const JSON_PREVIEW_COLLAPSE_LENGTH = 240;
const JSON_PREVIEW_MAX_DEPTH = 32;
const JSON_PREVIEW_MAX_NODES = 4_096;
export const JSON_PREVIEW_THEME_PROPERTIES = [
	'--c-bg',
	'--c-ice',
	'--c-sand',
	'--c-cyan',
	'--c-yellow',
	'--c-orange'
] as const;
export type JsonPreviewTheme = Record<(typeof JSON_PREVIEW_THEME_PROPERTIES)[number], string>;

function fitsTreeBudget(value: unknown): boolean {
	const pending = [{ value, depth: 0 }];
	let remaining = JSON_PREVIEW_MAX_NODES;
	while (pending.length) {
		const item = pending.pop()!;
		if (--remaining < 0 || item.depth > JSON_PREVIEW_MAX_DEPTH) return false;
		if (item.value !== null && typeof item.value === 'object') {
			for (const key in item.value) {
				if (!Object.hasOwn(item.value, key)) continue;
				if (pending.length >= remaining) return false;
				pending.push({
					value: (item.value as Record<string, unknown>)[key],
					depth: item.depth + 1
				});
			}
		}
	}
	return true;
}

function textFragment(value: string): string {
	const escaped = escapeHtml(value);
	if (value.length <= JSON_PREVIEW_COLLAPSE_LENGTH) return `<code>${escaped}</code>`;
	return `<details class="json-fragment"><summary>${escapeHtml(value.slice(0, 64))}… <span class="muted">(${value.length.toLocaleString('en-US')} characters)</span></summary><code>${escaped}</code></details>`;
}

function renderValue(value: unknown, depth = 0, prefix = '', suffix = ''): string {
	const row = (content: string) =>
		`<div class="json-line" style="padding-left:${depth}rem">${content}</div>`;
	if (value === null || typeof value !== 'object') {
		return row(prefix + textFragment(JSON.stringify(value)) + suffix);
	}
	const array = Array.isArray(value);
	const entries = Object.entries(value);
	if (!entries.length) return row(prefix + (array ? '[]' : '{}') + suffix);
	return (
		row(prefix + (array ? '[' : '{')) +
		entries
			.map(([key, child], index) =>
				renderValue(
					child,
					depth + 1,
					array ? '' : `<span class="json-key">${textFragment(JSON.stringify(key))}</span>: `,
					index < entries.length - 1 ? ',' : ''
				)
			)
			.join('') +
		row((array ? ']' : '}') + suffix)
	);
}

export function buildJsonPreviewDocument(text: string, theme: JsonPreviewTheme): string {
	let content: string;
	try {
		const parsed: unknown = JSON.parse(text);
		content = fitsTreeBudget(parsed)
			? renderValue(parsed)
			: `<p class="muted">Large document · original response</p>${textFragment(text)}`;
	} catch {
		content = `<p class="muted">Response is not valid JSON</p>${textFragment(text)}`;
	}
	// Theme values originate in app.css, never in token metadata. Escape them even
	// so: generated documents must have no HTML interpolation from their inputs.
	const variables = JSON_PREVIEW_THEME_PROPERTIES.map(
		(key) => `${key}:${escapeHtml(theme[key])};`
	).join('');
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>tokenURI response</title>
<style>
:root{${variables}}
body{margin:0;padding:.5rem;background:var(--c-bg);color:var(--c-ice);font:11px/1.45 monospace}
code{font:inherit}.json-line{min-height:1.45em;white-space:pre-wrap;overflow-wrap:anywhere}
.json-key,summary{color:var(--c-cyan)}.muted{color:var(--c-sand)}
.json-fragment{display:inline;white-space:pre-wrap;overflow-wrap:anywhere}
.json-fragment>summary{display:inline;cursor:pointer}.json-fragment>summary::before{content:'▸ '}
.json-fragment[open]>summary{color:var(--c-orange)}.json-fragment[open]>summary::before{content:'▾ '}
.json-fragment>code{display:block;margin:.35rem 0;max-height:24rem;overflow:auto}
summary:hover,summary:focus-visible{color:var(--c-yellow)}
</style></head><body>${content}</body></html>`;
}
