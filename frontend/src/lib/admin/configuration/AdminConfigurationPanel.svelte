<script lang="ts">
	import AdminSectionFrame from '$lib/admin/components/AdminSectionFrame.svelte';
	import type {
		AdminConfigField,
		AdminConfigGroup,
		AdminConfigSaveInput,
		AdminConfigState
	} from '$lib/admin/configuration/ports';

	type AdminConfigView = 'basic' | 'advanced';

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
	let configView = $state<AdminConfigView>('basic');

	const editableGroups = $derived(resolveEditableGroups(config?.groups ?? [], configView));
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

	function resolveEditableGroups(groups: AdminConfigGroup[], view: AdminConfigView): AdminConfigGroup[] {
		return groups
			.map((group) => ({
				...group,
				fields:
					view === 'advanced'
						? group.fields
						: group.fields.filter((field) => field.view === 'basic')
			}))
			.filter((group) => group.fields.length > 0);
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
					<div class="admin-config-view-row">
						<span class="panel-top-actions-label">view:</span>
						<div class="secondary-tabs" aria-label="Config view">
							<button
								type="button"
								class:secondary-tab-active={configView === 'basic'}
								disabled={formDisabled || configView === 'basic'}
								onclick={() => {
									configView = 'basic';
								}}
							>
								basic
							</button>
							<button
								type="button"
								class:secondary-tab-active={configView === 'advanced'}
								disabled={formDisabled || configView === 'advanced'}
								onclick={() => {
									configView = 'advanced';
								}}
							>
								advanced
							</button>
						</div>
					</div>

					<section class="runtime-section admin-config-group">
						<h3>Desktop</h3>
						<label class="admin-config-row admin-config-checkbox-row">
							<span>autostart infra</span>
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
						<div class="admin-config-actions">
							<div class="admin-config-action-group">
								<button
									type="button"
									class="action-button-negative"
									onclick={onClose}
									disabled={busyAction !== null}
								>
									cancel
								</button>
								<button
									type="button"
									class="action-button-negative"
									onclick={resetDraftToDefaults}
									disabled={formDisabled}
								>
									reset defaults
								</button>
							</div>
							<div class="admin-config-action-group">
								<button type="submit" class="action-button-positive" disabled={formDisabled}>
									{busyAction === 'save' ? 'saving...' : 'save'}
								</button>
							</div>
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
		gap: 1.1rem;
		width: min(62rem, 100%);
	}

	.admin-config-form {
		display: grid;
		gap: 1.35rem;
	}

	.admin-config-group {
		align-content: start;
		gap: 0.72rem;
	}

	.admin-config-view-row {
		display: flex;
		align-items: center;
		justify-content: flex-start;
		gap: var(--control-button-gap);
		flex-wrap: wrap;
		width: min(40.15rem, 100%);
		max-width: 100%;
	}

	.admin-config-row {
		display: grid;
		grid-template-columns: minmax(9.5rem, 13.6rem) minmax(8rem, 25.85rem);
		align-items: center;
		gap: 0.7rem;
		width: min(40.15rem, 100%);
		max-width: 100%;
	}

	.admin-config-row > span {
		font-size: 0.75rem;
		text-transform: uppercase;
		color: var(--c-sand);
		line-height: 1.15;
	}

	.admin-config-checkbox-row {
		grid-template-columns: minmax(9.5rem, 13.6rem) max-content;
	}

	.admin-config-textarea-row {
		align-items: start;
	}

	.admin-config-control {
		width: min(25.85rem, 100%);
	}

	.admin-config-textarea {
		min-height: 4.5rem;
		resize: vertical;
	}

	.admin-config-actions {
		display: grid;
		grid-template-columns: max-content 1fr;
		align-items: center;
		gap: 2rem;
		width: min(40.15rem, 100%);
		max-width: 100%;
		overflow-x: auto;
		padding-bottom: 0.1rem;
	}

	.admin-config-action-group {
		display: flex;
		align-items: center;
		gap: 0.45rem;
	}

	.admin-config-action-group:last-child {
		justify-self: end;
	}

	.admin-config-actions button {
		min-width: 8.75rem;
	}
</style>
