<script lang="ts">
	import AdminSectionFrame from '$lib/admin/components/AdminSectionFrame.svelte';
	import type {
		AdminConfigField,
		AdminConfigGroup,
		AdminConfigSaveInput,
		AdminConfigState
	} from '$lib/admin/configuration/ports';

	let {
		config,
		loading,
		busyAction = null,
		errorMessage = null,
		onSave,
		onClose
	}: {
		config: AdminConfigState | null;
		loading: boolean;
		busyAction?: string | null;
		errorMessage?: string | null;
		onSave: (input: AdminConfigSaveInput) => Promise<void>;
		onClose: () => void;
	} = $props();

	let appliedConfig = $state<AdminConfigState | null>(null);
	let values = $state<Record<string, string>>({});
	let autoLaunchOnStartup = $state(false);

	const editableGroups = $derived((config?.groups ?? []).filter((group) => group.fields.length > 0));
	const formDisabled = $derived(loading || busyAction !== null || config === null);

	$effect(() => {
		if (!config || config === appliedConfig) {
			return;
		}
		applyConfigState(config);
	});

	function applyConfigState(next: AdminConfigState): void {
		appliedConfig = next;
		values = { ...next.values };
		autoLaunchOnStartup = next.autoLaunchOnStartup;
	}

	function setValue(key: string, value: string): void {
		values = {
			...values,
			[key]: value
		};
	}

	function resetDraftToDefaults(): void {
		if (!config) {
			return;
		}
		values = { ...config.defaults };
		autoLaunchOnStartup = false;
	}

	async function saveConfig(): Promise<void> {
		if (formDisabled) {
			return;
		}
		await onSave({
			values,
			autoLaunchOnStartup
		});
	}

	function fieldValue(field: AdminConfigField): string {
		return values[field.key] ?? '';
	}

	function fieldChecked(field: AdminConfigField): boolean {
		return ['1', 'true', 'yes', 'on'].includes(fieldValue(field).trim().toLowerCase());
	}
</script>

<AdminSectionFrame>
	<div class="admin-config-body">
		<div class="admin-config-inlay">
			{#if loading}
				<section class="runtime-section">
					<p class="muted">loading configuration</p>
				</section>
			{:else if config}
				<form
					class="admin-config-form"
					onsubmit={(event) => {
						event.preventDefault();
						void saveConfig();
					}}
				>
					<section class="runtime-section admin-config-group">
						<h3>Desktop</h3>
						<label class="admin-config-row admin-config-checkbox-row">
							<span>launch on startup</span>
							<input
								type="checkbox"
								class="bootstrap-checkbox"
								checked={autoLaunchOnStartup}
								disabled={formDisabled}
								onchange={(event) => {
									autoLaunchOnStartup = (event.currentTarget as HTMLInputElement).checked;
								}}
							/>
						</label>
					</section>

					{#each editableGroups as group (group.id)}
						<section class="runtime-section admin-config-group">
							<h3>{group.label}</h3>
							{#each group.fields as field (field.key)}
								<label class="admin-config-row" class:admin-config-textarea-row={field.inputKind === 'textarea'}>
									<span>{field.label}</span>
									{#if field.inputKind === 'checkbox'}
										<input
											type="checkbox"
											class="bootstrap-checkbox"
											checked={fieldChecked(field)}
											disabled={formDisabled}
											onchange={(event) => {
												setValue(field.key, (event.currentTarget as HTMLInputElement).checked ? 'true' : 'false');
											}}
										/>
									{:else if field.inputKind === 'select'}
										<select
											class="bootstrap-control-select admin-config-control"
											value={fieldValue(field)}
											disabled={formDisabled}
											onchange={(event) => {
												setValue(field.key, (event.currentTarget as HTMLSelectElement).value);
											}}
										>
											{#each field.options as option}
												<option value={option}>{option}</option>
											{/each}
										</select>
									{:else if field.inputKind === 'textarea'}
										<textarea
											class="bootstrap-control-textarea admin-config-control admin-config-textarea"
											value={fieldValue(field)}
											disabled={formDisabled}
											oninput={(event) => {
												setValue(field.key, (event.currentTarget as HTMLTextAreaElement).value);
											}}
										></textarea>
									{:else}
										<input
											class="bootstrap-control admin-config-control"
											type={field.inputKind === 'password' ? 'password' : 'text'}
											value={fieldValue(field)}
											disabled={formDisabled}
											oninput={(event) => {
												setValue(field.key, (event.currentTarget as HTMLInputElement).value);
											}}
										/>
									{/if}
								</label>
							{/each}
						</section>
					{/each}

					<section class="runtime-section">
						<div class="runtime-controls admin-config-actions">
							<button type="submit" disabled={formDisabled}>
								{busyAction === 'save' ? 'saving...' : 'save'}
							</button>
							<button type="button" onclick={resetDraftToDefaults} disabled={formDisabled}>
								reset to defaults
							</button>
							<button type="button" onclick={onClose} disabled={busyAction !== null}>
								cancel
							</button>
						</div>
					</section>
				</form>
			{:else}
				<section class="runtime-section">
					<p class="runtime-error" role="alert">{errorMessage ?? 'configuration unavailable'}</p>
				</section>
			{/if}
		</div>
	</div>
</AdminSectionFrame>

<style>
	.admin-config-body {
		height: 100%;
		display: grid;
		align-content: start;
	}

	.admin-config-inlay {
		display: grid;
		gap: 0.85rem;
		width: min(62rem, 100%);
	}

	.admin-config-form {
		display: grid;
		gap: 0.85rem;
	}

	.admin-config-group {
		align-content: start;
	}

	.admin-config-row {
		display: grid;
		grid-template-columns: minmax(12rem, 17rem) minmax(16rem, 34rem);
		align-items: center;
		gap: 0.7rem;
		width: fit-content;
		max-width: 100%;
	}

	.admin-config-row > span {
		font-size: 0.75rem;
		text-transform: uppercase;
		color: var(--c-sand);
		line-height: 1.15;
	}

	.admin-config-checkbox-row {
		grid-template-columns: minmax(12rem, 17rem) max-content;
	}

	.admin-config-textarea-row {
		align-items: start;
	}

	.admin-config-control {
		width: min(34rem, 100%);
	}

	.admin-config-textarea {
		min-height: 4.5rem;
		resize: vertical;
	}

	.admin-config-actions {
		align-items: center;
	}

	@media (max-width: 48rem) {
		.admin-config-row,
		.admin-config-checkbox-row {
			grid-template-columns: 1fr;
			gap: 0.35rem;
		}

		.admin-config-control {
			width: 100%;
		}
	}
</style>
