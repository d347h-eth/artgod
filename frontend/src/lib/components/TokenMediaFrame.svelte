<script lang="ts">
	import type { TokenMediaIframeSource } from '$lib/token-media';

	let {
		iframeSource,
		title,
		className = '',
		hideScrollbars = false,
		allowScripts = true
	}: {
		iframeSource: TokenMediaIframeSource;
		title: string;
		className?: string;
		hideScrollbars?: boolean;
		// Inert document inspection needs fewer permissions than generative artwork.
		allowScripts?: boolean;
	} = $props();

	// Legacy iframe scrolling control still applies before isolated documents load.
	const IFRAME_SCROLLING_DISABLED = 'no';
</script>

<iframe
	class={className}
	src={iframeSource.kind === 'src' ? iframeSource.value : undefined}
	srcdoc={iframeSource.kind === 'srcdoc' ? iframeSource.value : undefined}
	{title}
	sandbox={allowScripts ? 'allow-scripts' : ''}
	referrerpolicy="no-referrer"
	scrolling={hideScrollbars ? IFRAME_SCROLLING_DISABLED : undefined}
></iframe>
