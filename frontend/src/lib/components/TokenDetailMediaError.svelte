<script lang="ts">
	let { message, onRetry }: { message: string; onRetry: () => void } = $props();
</script>

<div class="token-detail-media-error" role="alert">
	<span>{message}</span>
	<button
		type="button"
		class="facet-panel-action-button token-detail-media-retry"
		aria-label="retry loading media"
		onclick={onRetry}
	>
		retry
	</button>
</div>
