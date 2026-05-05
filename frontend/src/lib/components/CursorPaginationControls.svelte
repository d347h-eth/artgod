<script lang="ts">
	import type { Snippet } from 'svelte';

	type MaybePromise<T> = T | Promise<T>;

	let {
		resultsSummary,
		totalItems,
		rangeStart,
		rangeEnd,
		totalPages,
		visibleStartPage,
		visibleEndPage,
		remainingItems,
		pagesLoaded,
		hasPreviousPage,
		previousHref = '#',
		previousBusy = false,
		onPrevious,
		hasNextPage,
		nextHref = '#',
		nextBusy = false,
		onNext,
		endLabel,
		footerClass = '',
		actions,
		children
	}: {
		resultsSummary: string;
		totalItems: number;
		rangeStart: number;
		rangeEnd: number;
		totalPages: number;
		visibleStartPage: number;
		visibleEndPage: number;
		remainingItems: number;
		pagesLoaded: number;
		hasPreviousPage: boolean;
		previousHref?: string;
		previousBusy?: boolean;
		onPrevious: (event: MouseEvent) => MaybePromise<void>;
		hasNextPage: boolean;
		nextHref?: string;
		nextBusy?: boolean;
		onNext: (event: MouseEvent) => MaybePromise<void>;
		endLabel: string;
		footerClass?: string;
		actions?: Snippet;
		children: Snippet;
	} = $props();

	function footerClasses(): string {
		return ['panel-footer', footerClass].filter(Boolean).join(' ');
	}

	function handlePrevious(event: MouseEvent): void {
		void onPrevious(event);
	}

	function handleNext(event: MouseEvent): void {
		void onNext(event);
	}
</script>

<div class="results-toolbar">
	<span class="mono token-results-summary">{resultsSummary}</span>
	<div class="results-toolbar-actions">
		{#if hasPreviousPage}
			<a
				class="button-link"
				href={previousHref}
				aria-busy={previousBusy}
				onclick={handlePrevious}>load previous</a
			>
		{/if}
		{#if actions}
			{@render actions()}
		{/if}
	</div>
</div>

{@render children()}

<footer class={footerClasses()}>
	<div class="pagination-summary">
		{#if totalItems === 0}
			<span class="muted">showing 0 of 0</span>
		{:else}
			<span class="mono">showing {rangeStart}-{rangeEnd} of {totalItems}</span>
			{#if visibleStartPage > 0 && visibleEndPage > 0}
				{#if visibleStartPage === visibleEndPage}
					<span class="muted">page {visibleStartPage} / {totalPages}</span>
				{:else}
					<span class="muted">pages {visibleStartPage}-{visibleEndPage} / {totalPages}</span>
				{/if}
			{/if}
			<span class="muted">{remainingItems} left</span>
			{#if pagesLoaded > 1}
				<span class="muted">loaded {pagesLoaded} pages</span>
			{/if}
		{/if}
	</div>
	{#if hasNextPage}
		<a class="button-link" href={nextHref} aria-busy={nextBusy} onclick={handleNext}>load next</a>
	{:else}
		<span class="muted">{endLabel}</span>
	{/if}
</footer>
