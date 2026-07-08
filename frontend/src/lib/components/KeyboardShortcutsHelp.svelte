<script lang="ts">
	import {
		getDefaultBlockExplorerConfig,
		type BlockExplorerConfig
	} from '@artgod/shared/config/block-explorer';
	import type { KeyboardShortcutsHelpController } from '$lib/components/keyboard-shortcuts-help-controller';
	import { blockExplorerAddressHref as buildBlockExplorerAddressHref } from '$lib/marketplace-links';
	import { APP_VERSION } from '$lib/runtime/app-version';

	type ShortcutSection = {
		title: string;
		entries: Array<{
			keys: string[];
			description: string;
		}>;
	};

	const SECTIONS: ShortcutSection[] = [
		{
			title: 'Help',
			entries: [
				{
					keys: ['F1'],
					description: 'open or close this shortcuts modal'
				}
			]
		},
		{
			title: 'Token Browser',
			entries: [
				{
					keys: ['V'],
					description: 'switch to the next media mode for current token results'
				}
			]
		},
		{
			title: 'Token Browser Preview Navigation',
			entries: [
				{
					keys: ['A', '←'],
					description: 'open the previous token in the current visible results'
				},
				{
					keys: ['D', '→'],
					description: 'open the next token in the current visible results'
				}
			]
		},
		{
			title: 'Traits Filtering Panel',
			entries: [
				{
					keys: ['F'],
					description: 'toggle the traits filtering panel'
				},
				{
					keys: ['R'],
					description: 'reset current trait filters'
				}
			]
		},
		{
			title: 'Collection Navigation',
			entries: [
				{
					keys: ['1'],
					description: 'open asks'
				},
				{
					keys: ['2'],
					description: 'open offers'
				},
				{
					keys: ['3'],
					description: 'open tokens'
				}
			]
		},
		{
			title: 'Bidding',
			entries: [
				{
					keys: ['Ctrl+LMB', 'MMB'],
					description: 'append or remove token card from bidding selection'
				},
				{
					keys: ['Ctrl+Alt+LMB', 'Alt+MMB'],
					description: 'select only this token card for bidding'
				},
				{
					keys: ['S'],
					description: 'cycle bid scope'
				},
				{
					keys: ['T'],
					description: 'toggle tiers management'
				},
				{
					keys: ['B'],
					description: 'hide or show the bidding panel'
				},
				{
					keys: ['C'],
					description: 'clear the current bidding target'
				}
			]
		},
		{
			title: 'Preview Modal',
			entries: [
				{
					keys: ['V'],
					description: 'switch to the next media mode for the opened token'
				},
				{
					keys: ['-'],
					description: 'decrease preview height'
				},
				{
					keys: ['+'],
					description: 'increase preview height'
				},
				{
					keys: ['0'],
					description: 'reset preview height'
				}
			]
		}
	];

	const ABOUT_COPY =
		'ArtGod is free and copyleft open-source software (AGPL-3.0). There is no funding, no sale, no airdrop, no farming, and no token.';
	const DONATIONS_ENS_NAME = 'donations.artgod.eth';
	const ARTGOD_ENS_NAME = 'artgod.eth';
	const DIRECT_LINKS = [
		{ label: 'artgod.network', href: 'https://artgod.network/' },
		{ label: 'x.com/artgod_eth', href: 'https://x.com/artgod_eth' },
		{ label: 'github.com/d347h-eth/artgod', href: 'https://github.com/d347h-eth/artgod' }
	];

	let {
		keyboardShortcutsHelp,
		blockExplorer = getDefaultBlockExplorerConfig()
	}: {
		keyboardShortcutsHelp: KeyboardShortcutsHelpController;
		blockExplorer?: BlockExplorerConfig;
	} = $props();

	const keyboardShortcutsHelpState = keyboardShortcutsHelp.state;
	const donationsExplorerHref = $derived(
		buildBlockExplorerAddressHref(DONATIONS_ENS_NAME, blockExplorer)
	);
	const artgodEnsExplorerHref = $derived(buildBlockExplorerAddressHref(ARTGOD_ENS_NAME, blockExplorer));

	function onBackdropClick(event: MouseEvent): void {
		if (event.target !== event.currentTarget) return;
		keyboardShortcutsHelp.close();
	}
</script>

<button
	type="button"
	class="button-link panel-header-help-button"
	aria-label="keyboard shortcuts"
	title="keyboard shortcuts (F1)"
	onclick={() => keyboardShortcutsHelp.toggle()}
>
	?
</button>

{#if $keyboardShortcutsHelpState.open}
	<div class="shortcuts-help-backdrop" role="presentation" onclick={onBackdropClick}>
		<div
			class="shortcuts-help-modal"
			role="dialog"
			aria-modal="true"
			aria-labelledby="shortcuts-help-title"
		>
			<header class="shortcuts-help-header">
				<h2 id="shortcuts-help-title" class="panel-title">ABOUT</h2>
				<button
					type="button"
					class="button-link panel-header-help-button"
					aria-label="close keyboard shortcuts"
					onclick={() => keyboardShortcutsHelp.close()}
				>
					x
				</button>
			</header>

			<section class="shortcuts-help-about" aria-label="about ArtGod">
				<span class="muted">{APP_VERSION}</span>
				<p>{ABOUT_COPY}</p>
				<p>
					Donations welcome:
					<a href={donationsExplorerHref ?? undefined} target="_blank" rel="noreferrer noopener"
						>{DONATIONS_ENS_NAME}</a
					>
				</p>
				<div class="shortcuts-help-links">
					{#each DIRECT_LINKS as link}
						<a href={link.href} target="_blank" rel="noreferrer noopener">{link.label}</a>
					{/each}
					<a href={artgodEnsExplorerHref ?? undefined} target="_blank" rel="noreferrer noopener"
						>{ARTGOD_ENS_NAME}</a
					>
				</div>
			</section>

			<div class="shortcuts-help-grid" aria-label="keyboard shortcuts">
				{#each SECTIONS as section}
					<section class="shortcuts-help-section">
						<h3>{section.title}</h3>
						<ul class="shortcuts-help-list">
							{#each section.entries as entry}
								<li class="shortcuts-help-item">
									<div class="shortcuts-help-keys">
										{#each entry.keys as key}
											<kbd>{key}</kbd>
										{/each}
									</div>
									<p class="muted">{entry.description}</p>
								</li>
							{/each}
						</ul>
					</section>
				{/each}
			</div>
		</div>
	</div>
{/if}
