<script lang="ts">
	import AdminSectionFrame from '$lib/admin/components/AdminSectionFrame.svelte';
</script>

<AdminSectionFrame>
	<div class="admin-bots-body">
		<div class="admin-bots-inlay" role="status">No bot controls are available yet.</div>
	</div>
</AdminSectionFrame>

<style>
	.admin-bots-body {
		height: 100%;
		display: grid;
		align-content: start;
	}

	.admin-bots-inlay {
		border: 1px dashed rgba(113, 141, 188, 0.28);
		padding: 1rem;
		background: rgba(31, 38, 48, 0.34);
		color: var(--c-sand);
		font-size: 0.83rem;
		line-height: 1.55;
		width: min(32rem, 100%);
	}
</style>
