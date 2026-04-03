<script lang="ts">
	import type { TokenMediaIframeSource } from '$lib/token-media';

	let {
		iframeSource,
		title,
		className = ''
	}: {
		iframeSource: TokenMediaIframeSource;
		title: string;
		className?: string;
	} = $props();
</script>

<iframe
	class={className}
	src={iframeSource.kind === 'src' ? iframeSource.value : undefined}
	srcdoc={iframeSource.kind === 'srcdoc' ? iframeSource.value : undefined}
	{title}
	sandbox="allow-scripts"
	referrerpolicy="no-referrer"
></iframe>
