import { describe, expect, it } from 'vitest';
import {
	beginAdminBotRefresh,
	beginAdminBotViewAction,
	createAdminBotViewState,
	finishAdminBotRefreshFailure,
	finishAdminBotRefreshSuccess,
	isCurrentAdminBotRefresh,
	publishAdminBotActionError
} from './admin-bot-view-state';

describe('Admin bot view state', () => {
	it('keeps an action error when an older refresh succeeds later', () => {
		const refresh = beginAdminBotRefresh(createAdminBotViewState());
		const actionStarted = beginAdminBotViewAction(refresh.state);
		const actionFailed = publishAdminBotActionError(actionStarted, 'Start failed. Try again.');

		const completed = finishAdminBotRefreshSuccess(actionFailed, refresh.request);

		expect(completed).toEqual(actionFailed);
		expect(completed.error?.message).toBe('Start failed. Try again.');
	});

	it('keeps an action error when a later passive refresh succeeds', () => {
		const actionFailed = publishAdminBotActionError(
			beginAdminBotViewAction(createAdminBotViewState()),
			'Stop failed. Try again.'
		);
		const refresh = beginAdminBotRefresh(actionFailed);

		const completed = finishAdminBotRefreshSuccess(refresh.state, refresh.request);

		expect(completed.error?.message).toBe('Stop failed. Try again.');
	});

	it('keeps an action error when a passive refresh fails', () => {
		const actionFailed = publishAdminBotActionError(
			beginAdminBotViewAction(createAdminBotViewState()),
			'Stop failed. Try again.'
		);
		const refresh = beginAdminBotRefresh(actionFailed);

		const completed = finishAdminBotRefreshFailure(
			refresh.state,
			refresh.request,
			'Bot state could not be loaded.'
		);

		expect(completed.error?.message).toBe('Stop failed. Try again.');
	});

	it('allows a deliberate recovery refresh to clear an existing action error', () => {
		const actionFailed = publishAdminBotActionError(
			beginAdminBotViewAction(createAdminBotViewState()),
			'Start failed. Try again.'
		);
		const refresh = beginAdminBotRefresh(actionFailed, {
			clearActionErrorOnSuccess: true
		});

		const completed = finishAdminBotRefreshSuccess(refresh.state, refresh.request);

		expect(completed.error).toBeNull();
	});

	it('keeps an action error when a deliberate recovery refresh also fails', () => {
		const actionFailed = publishAdminBotActionError(
			beginAdminBotViewAction(createAdminBotViewState()),
			'Start failed. Try again.'
		);
		const refresh = beginAdminBotRefresh(actionFailed, {
			clearActionErrorOnSuccess: true
		});

		const completed = finishAdminBotRefreshFailure(
			refresh.state,
			refresh.request,
			'Bot state could not be loaded.'
		);

		expect(completed.error?.message).toBe('Start failed. Try again.');
	});

	it('ignores a refresh after a newer refresh has been reserved', () => {
		const first = beginAdminBotRefresh(createAdminBotViewState());
		const second = beginAdminBotRefresh(first.state);

		expect(isCurrentAdminBotRefresh(second.state, first.request)).toBe(false);
		expect(isCurrentAdminBotRefresh(second.state, second.request)).toBe(true);
		expect(
			finishAdminBotRefreshFailure(second.state, first.request, 'Stale refresh failure.')
		).toEqual(second.state);
	});

	it('replaces a refresh error after a later passive refresh succeeds', () => {
		const failedRefresh = beginAdminBotRefresh(createAdminBotViewState());
		const failed = finishAdminBotRefreshFailure(
			failedRefresh.state,
			failedRefresh.request,
			'Bot state could not be loaded.'
		);
		const recoveredRefresh = beginAdminBotRefresh(failed);

		const recovered = finishAdminBotRefreshSuccess(
			recoveredRefresh.state,
			recoveredRefresh.request
		);

		expect(recovered.error).toBeNull();
	});
});
