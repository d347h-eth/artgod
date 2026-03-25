export function normalizeBasePath(basePath: string): string {
	const trimmed = basePath.trim();
	if (!trimmed || trimmed === '/') {
		return '/';
	}
	return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

export function joinPath(basePath: string, segment: string): string {
	const normalizedBase = normalizeBasePath(basePath);
	const normalizedSegment = segment.replace(/^\/+/, '');
	if (normalizedBase === '/') {
		return `/${normalizedSegment}`;
	}
	return `${normalizedBase}/${normalizedSegment}`;
}

export function withQuery(path: string, query: URLSearchParams | string): string {
	const queryText = typeof query === 'string' ? query : query.toString();
	return queryText ? `${path}?${queryText}` : path;
}
