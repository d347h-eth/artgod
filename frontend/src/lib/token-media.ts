export type TokenMediaIframeSource =
	| {
			kind: 'src';
			value: string;
	  }
	| {
			kind: 'srcdoc';
			value: string;
	  };

export function tokenMediaTitle(tokenId: string): string {
	return `token ${tokenId}`;
}

export function resolveTokenMediaIframeSource(
	animationUrl: string | null,
	imageUrl: string | null,
	title: string
): TokenMediaIframeSource | null {
	if (animationUrl) {
		return {
			kind: 'src',
			value: animationUrl
		};
	}
	if (imageUrl) {
		return {
			kind: 'srcdoc',
			value: buildImagePreviewDocument(imageUrl, title)
		};
	}
	return null;
}

export function resolveTokenMediaAspectRatio(
	value: number | null | undefined,
	fallback: number | null
): number | null {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		return value;
	}
	if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0) {
		return fallback;
	}
	return null;
}

function buildImagePreviewDocument(imageUrl: string, title: string): string {
	const escapedUrl = escapeHtml(imageUrl);
	const escapedTitle = escapeHtml(title);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapedTitle}</title>
<style>
	html, body {
		margin: 0;
		width: 100%;
		height: 100%;
		background: #111;
	}
	body {
		display: grid;
		place-items: center;
		overflow: hidden;
	}
	img {
		display: block;
		max-width: 100%;
		max-height: 100%;
		width: auto;
		height: auto;
		object-fit: contain;
	}
</style>
</head>
<body>
<img src="${escapedUrl}" alt="${escapedTitle}" referrerpolicy="no-referrer" />
</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}
