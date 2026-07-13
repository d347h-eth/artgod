import { expect, test, type Page, type TestInfo } from 'playwright/test';
import {
	ADMIN_BOTS_AUTHORIZATION_SCENARIO,
	ADMIN_BOTS_AUTHORIZATION_SCENARIO_QUERY_PARAM,
	ADMIN_BOTS_INFRASTRUCTURE_OFFLINE_MESSAGE,
	type AdminBotsAuthorizationScenario
} from '../src/lib/e2e/admin-bots-authorization-fixtures';

const HARNESS_PATH = '/e2e-harness/admin/bots';

test('renders stopped settings and draft authorization', async ({ page }, testInfo) => {
	await openScenario(page, ADMIN_BOTS_AUTHORIZATION_SCENARIO.Stopped);
	await expect(page.getByRole('heading', { name: 'bidding settings' })).toBeVisible();
	await expect(page.getByText('13920 seconds (3 hours, 52 minutes)')).toBeVisible();
	await expect(page.getByRole('heading', { name: /bidding authorization request/ })).toBeVisible();
	await assertNoHorizontalOverflow(page);
	await attachSurface(page, testInfo, ADMIN_BOTS_AUTHORIZATION_SCENARIO.Stopped);

	await page.getByRole('checkbox').check();
	const cap = page.getByLabel('max WETH for any one NFT');
	await expect(cap).toBeEnabled();
	await cap.fill('1.5');
	await expect(page.getByRole('button', { name: 'start' })).toBeEnabled();
	await assertNoHorizontalOverflow(page);
	await attachSurface(page, testInfo, ADMIN_BOTS_AUTHORIZATION_SCENARIO.Draft);
});

test('keeps stop available while awaiting native wallet unlock', async ({ page }, testInfo) => {
	await openScenario(page, ADMIN_BOTS_AUTHORIZATION_SCENARIO.AwaitingUnlock);
	await expect(page.getByText('waiting for wallet unlock', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'stop' })).toBeEnabled();
	await expect(page.getByRole('checkbox')).toBeDisabled();
	await assertNoHorizontalOverflow(page);
	await attachSurface(page, testInfo, ADMIN_BOTS_AUTHORIZATION_SCENARIO.AwaitingUnlock);
});

test('renders mandate-frozen policy during bootstrap', async ({ page }, testInfo) => {
	await openScenario(page, ADMIN_BOTS_AUTHORIZATION_SCENARIO.Bootstrapping);
	await expect(page.getByText('preparing bidding', { exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'next-start bidding settings' })).toBeVisible();
	await expect(page.getByRole('heading', { name: /active bidding authorization/ })).toBeVisible();
	await expect(
		page.getByRole('heading', { name: /next-start bidding authorization request/ })
	).toBeVisible();
	await expect(page.getByText('0.5 WETH for the OpenSea conduit')).toHaveCount(2);
	await assertActiveAuthorizationComesFirst(page);
	await expect(page.getByRole('button', { name: 'stop' })).toBeEnabled();
	await assertNoHorizontalOverflow(page);
	await attachSurface(page, testInfo, ADMIN_BOTS_AUTHORIZATION_SCENARIO.Bootstrapping);
});

test('renders active policy and collection caps from one frozen mandate', async ({
	page
}, testInfo) => {
	await openScenario(page, ADMIN_BOTS_AUTHORIZATION_SCENARIO.Active);
	await expect(page.getByText('running', { exact: true })).toBeVisible();
	await expect(page.getByText('0.1 Gwei per gas')).toHaveCount(2);
	await expect(page.getByText('0.01 ETH per approval transaction')).toHaveCount(2);
	const activeAuthorization = page.getByRole('region', { name: 'Active bidding authorization' });
	await expect(activeAuthorization.getByText('1.25 WETH', { exact: true })).toBeVisible();
	await expect(activeAuthorization.getByText('1', { exact: true })).toBeVisible();
	await assertNoHorizontalOverflow(page);
	await attachSurface(page, testInfo, ADMIN_BOTS_AUTHORIZATION_SCENARIO.Active);
});

test('keeps active authority frozen when Config changes', async ({ page }, testInfo) => {
	await openScenario(page, ADMIN_BOTS_AUTHORIZATION_SCENARIO.ConfigDrift);
	const activeAuthorization = page.getByRole('region', { name: 'Active bidding authorization' });
	const nextStartSettings = page.getByRole('region', { name: 'Bidding settings' });
	await expect(activeAuthorization.getByText('0.5 WETH for the OpenSea conduit')).toBeVisible();
	await expect(nextStartSettings.getByText('9 WETH for the OpenSea conduit')).toBeVisible();
	await expect(activeAuthorization.getByText("enabled · OpenSea's pinned SignedZone is trusted")).toBeVisible();
	await expect(nextStartSettings.getByText('disabled', { exact: true })).toBeVisible();
	await expect(activeAuthorization.getByText('0.1 Gwei per gas')).toBeVisible();
	await expect(nextStartSettings.getByText('1 Gwei per gas')).toBeVisible();
	await expect(activeAuthorization.getByText('10 Gwei per gas')).toBeVisible();
	await expect(nextStartSettings.getByText('20 Gwei per gas')).toBeVisible();
	await expect(activeAuthorization.getByText('0.01 ETH per approval transaction')).toBeVisible();
	await expect(nextStartSettings.getByText('0.2 ETH per approval transaction')).toBeVisible();
	await expect(
		activeAuthorization.getByText('fail if the wallet already has pending transactions')
	).toBeVisible();
	await expect(
		nextStartSettings.getByText('fail if the wallet already has pending transactions')
	).toBeVisible();
	await assertActiveAuthorizationComesFirst(page);
	await assertNoHorizontalOverflow(page);
	await attachSurface(page, testInfo, ADMIN_BOTS_AUTHORIZATION_SCENARIO.ConfigDrift);
});

test('renders actionable validation recovery without hiding safe bot state', async ({
	page
}, testInfo) => {
	await openScenario(page, ADMIN_BOTS_AUTHORIZATION_SCENARIO.ValidationError);
	await expect(page.getByRole('alert')).toContainText(
		'Review Config, save the correction, then refresh Bots.'
	);
	await expect(page.getByText('stopped', { exact: true })).toBeVisible();
	await assertNoHorizontalOverflow(page);
	await attachSurface(page, testInfo, ADMIN_BOTS_AUTHORIZATION_SCENARIO.ValidationError);
});

test('keeps wallet unassignment available while infrastructure is offline', async ({ page }) => {
	await openScenario(page, ADMIN_BOTS_AUTHORIZATION_SCENARIO.InfrastructureOffline);
	const botState = page.getByRole('region', { name: 'Bot state' });
	const authorization = page.getByRole('region', { name: 'Bidding authorization request' });
	const walletSelect = page.getByRole('combobox');

	await expect(botState.getByText('stopped', { exact: true })).toBeVisible();
	await expect(
		botState.getByText('Bidding wallet · 0x1111111111111111111111111111111111111111')
	).toBeVisible();
	await expect(walletSelect).toBeEnabled();
	await expect(page.getByRole('button', { name: 'apply wallet' })).toBeEnabled();
	await expect(authorization.getByRole('alert')).toHaveText(
		ADMIN_BOTS_INFRASTRUCTURE_OFFLINE_MESSAGE
	);
	await expect(page.getByRole('button', { name: 'start' })).toBeDisabled();

	await walletSelect.selectOption('');
	await page.getByRole('button', { name: 'apply wallet' }).click();

	await expect(botState.getByText('unassigned', { exact: true })).toBeVisible();
	await expect(walletSelect).toHaveValue('');
	await expect(authorization.getByRole('alert')).toHaveText(
		ADMIN_BOTS_INFRASTRUCTURE_OFFLINE_MESSAGE
	);
	await expect(page.getByRole('button', { name: 'start' })).toBeDisabled();
});

async function openScenario(page: Page, scenario: AdminBotsAuthorizationScenario): Promise<void> {
	await page.goto(
		`${HARNESS_PATH}?${ADMIN_BOTS_AUTHORIZATION_SCENARIO_QUERY_PARAM}=${scenario}`,
		{ waitUntil: 'networkidle' }
	);
	await expect(page.getByLabel('Configured bot runtimes')).toBeVisible();
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
	const dimensions = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		clientWidth: document.documentElement.clientWidth
	}));
	expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function assertActiveAuthorizationComesFirst(page: Page): Promise<void> {
	const headings = await page.getByRole('heading').allTextContents();
	const activeIndex = headings.findIndex((heading) => heading.includes('active bidding authorization'));
	const nextStartIndex = headings.findIndex((heading) => heading.includes('next-start bidding settings'));
	expect(activeIndex).toBeGreaterThanOrEqual(0);
	expect(nextStartIndex).toBeGreaterThan(activeIndex);
}

async function attachSurface(
	page: Page,
	testInfo: TestInfo,
	scenario: AdminBotsAuthorizationScenario
): Promise<void> {
	const screenshotPath = testInfo.outputPath(`${testInfo.project.name}-${scenario}.png`);
	await page.screenshot({ path: screenshotPath, fullPage: true });
	await testInfo.attach(`${testInfo.project.name}-${scenario}.png`, {
		path: screenshotPath,
		contentType: 'image/png'
	});
}
