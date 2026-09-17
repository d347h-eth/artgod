import { expect, test, type Locator, type Page, type TestInfo } from 'playwright/test';
import { TCP_PORT_RANGE } from '@artgod/shared/config/tcp-port';
import { getSettingDefault } from '@artgod/shared/config/generated-settings-defaults';
import {
	ADMIN_CONFIG_OBSERVABILITY_FIELD,
	ADMIN_CONFIG_OBSERVABILITY_TEST_ID,
	createAdminConfigObservabilityFixture
} from '../src/lib/e2e/admin-config-observability-fixtures';
import { CONFIG_OBSERVABILITY_HARNESS } from './config-observability-harness.mjs';

test('renders the disabled default and validates the opt-in metrics port', async ({
	page
}, testInfo) => {
	await page.goto(CONFIG_OBSERVABILITY_HARNESS.routePath, { waitUntil: 'networkidle' });
	await page.getByRole('button', { name: 'advanced' }).click();

	const groupHeading = page.getByRole('heading', { name: 'Trading Observability' });
	const group = groupHeading.locator('..');
	const enabled = group.getByRole('checkbox');
	const port = group.getByRole('textbox');
	const save = page.getByRole('button', { name: 'save' });

	await expect(enabled).not.toBeChecked();
	await expect(port).toHaveValue(getSettingDefault(ADMIN_CONFIG_OBSERVABILITY_FIELD.Port));
	await expect(
		page.getByText('Saved changes apply after the affected ArtGod process restarts.')
	).toBeVisible();
	await assertNoHorizontalOverflow(page);
	await attachSurface(page, testInfo, 'disabled-default');

	await enabled.check();
	await port.fill('');
	await expect(port).toHaveAttribute('aria-invalid', 'true');
	await expect(save).toBeDisabled();

	await port.fill('0');
	await expect(port).toHaveAttribute('aria-invalid', 'true');
	await expect(save).toBeDisabled();
	await group.getByRole('button', { name: 'Warning details' }).hover();
	const portField = createAdminConfigObservabilityFixture()
		.groups.flatMap((group) => group.fields)
		.find((field) => field.key === ADMIN_CONFIG_OBSERVABILITY_FIELD.Port);
	if (!portField) throw new Error('Metrics port is missing from the Admin schema');
	const warning = group.locator('[role="tooltip"]').filter({
		hasText: `${portField.label} must be a whole number from ${TCP_PORT_RANGE.Minimum} to ${TCP_PORT_RANGE.Maximum}.`
	});
	await expect(warning).toBeVisible();
	await assertElementsDoNotOverlap(warning, page.getByRole('button', { name: 'cancel' }));
	await assertNoHorizontalOverflow(page);
	await attachSurface(page, testInfo, 'invalid-port');

	await port.fill(getSettingDefault(ADMIN_CONFIG_OBSERVABILITY_FIELD.Port));
	await expect(port).toHaveAttribute('aria-invalid', 'false');
	await expect(save).toBeEnabled();
	await page.mouse.move(1, 1);
	await assertNoHorizontalOverflow(page);
	await attachSurface(page, testInfo, 'enabled-valid');

	await save.click();
	const savedPayload = JSON.parse(
		(await page.getByTestId(ADMIN_CONFIG_OBSERVABILITY_TEST_ID.SavedConfig).textContent()) ?? ''
	) as { values: Record<string, string>; autoLaunchOnStartup: boolean };
	expect(savedPayload.values).toMatchObject({
		[ADMIN_CONFIG_OBSERVABILITY_FIELD.Enabled]: 'true',
		[ADMIN_CONFIG_OBSERVABILITY_FIELD.Port]: getSettingDefault(
			ADMIN_CONFIG_OBSERVABILITY_FIELD.Port
		)
	});
	expect(savedPayload.autoLaunchOnStartup).toBe(false);
});

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
	const dimensions = await page.evaluate(() => {
		const clientWidth = document.documentElement.clientWidth;
		const clippedControls = Array.from(
			document.querySelectorAll<HTMLElement>('button, input, select, textarea')
		)
			.filter((element) => element.offsetParent !== null)
			.map((element) => ({
				label: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.tagName,
				rect: element.getBoundingClientRect()
			}))
			.filter(({ rect }) => rect.left < 0 || rect.right > clientWidth)
			.map(({ label, rect }) => ({ label, left: rect.left, right: rect.right }));

		return {
			scrollWidth: document.documentElement.scrollWidth,
			clientWidth,
			clippedControls
		};
	});
	expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
	expect(dimensions.clippedControls).toEqual([]);
}

async function assertElementsDoNotOverlap(first: Locator, second: Locator): Promise<void> {
	const firstBox = await first.boundingBox();
	const secondBox = await second.boundingBox();
	expect(firstBox).not.toBeNull();
	expect(secondBox).not.toBeNull();
	if (!firstBox || !secondBox) return;

	const overlaps =
		firstBox.x < secondBox.x + secondBox.width &&
		firstBox.x + firstBox.width > secondBox.x &&
		firstBox.y < secondBox.y + secondBox.height &&
		firstBox.y + firstBox.height > secondBox.y;
	expect(overlaps).toBe(false);
}

async function attachSurface(page: Page, testInfo: TestInfo, state: string): Promise<void> {
	const screenshotPath = testInfo.outputPath(`${testInfo.project.name}-${state}.png`);
	await page.screenshot({ path: screenshotPath, fullPage: true });
	await testInfo.attach(`${testInfo.project.name}-${state}.png`, {
		path: screenshotPath,
		contentType: 'image/png'
	});
}
