// Identifies whether the visible bot error came from an action or state refresh.
const ADMIN_BOT_ERROR_OWNER = {
	Action: 'action',
	Refresh: 'refresh'
} as const;

type AdminBotErrorOwner = (typeof ADMIN_BOT_ERROR_OWNER)[keyof typeof ADMIN_BOT_ERROR_OWNER];

type AdminBotErrorState = Readonly<{
	message: string;
	owner: AdminBotErrorOwner;
}>;

// Tracks refresh ordering and feedback revisions for the Admin bot surface.
export type AdminBotViewState = Readonly<{
	feedbackRevision: number;
	latestRefreshRequest: number;
	error: AdminBotErrorState | null;
}>;

// Captures the revisions that one asynchronous refresh is allowed to publish against.
export type AdminBotRefreshRequest = Readonly<{
	request: number;
	feedbackRevision: number;
	clearActionErrorOnSuccess: boolean;
}>;

// Creates the initial Admin bot view state.
export function createAdminBotViewState(): AdminBotViewState {
	return {
		feedbackRevision: 0,
		latestRefreshRequest: 0,
		error: null
	};
}

// Reserves the newest refresh while remembering which feedback revision it observed.
export function beginAdminBotRefresh(
	state: AdminBotViewState,
	options: { clearActionErrorOnSuccess?: boolean } = {}
): { state: AdminBotViewState; request: AdminBotRefreshRequest } {
	const request = state.latestRefreshRequest + 1;
	return {
		state: {
			...state,
			latestRefreshRequest: request
		},
		request: {
			request,
			feedbackRevision: state.feedbackRevision,
			clearActionErrorOnSuccess: options.clearActionErrorOnSuccess === true
		}
	};
}

// Reports whether a refresh still owns data and loading-state publication.
export function isCurrentAdminBotRefresh(
	state: AdminBotViewState,
	request: AdminBotRefreshRequest
): boolean {
	return state.latestRefreshRequest === request.request;
}

// Clears prior feedback and invalidates feedback publication from older refreshes.
export function beginAdminBotViewAction(state: AdminBotViewState): AdminBotViewState {
	return advanceAdminBotFeedback(state, null);
}

// Publishes the actionable failure owned by the newest bot action.
export function publishAdminBotActionError(
	state: AdminBotViewState,
	message: string
): AdminBotViewState {
	return advanceAdminBotFeedback(state, {
		message,
		owner: ADMIN_BOT_ERROR_OWNER.Action
	});
}

// Applies refresh success without allowing passive or older work to erase action feedback.
export function finishAdminBotRefreshSuccess(
	state: AdminBotViewState,
	request: AdminBotRefreshRequest
): AdminBotViewState {
	if (!refreshMayMutateFeedback(state, request)) {
		return state;
	}
	if (state.error?.owner === ADMIN_BOT_ERROR_OWNER.Action && !request.clearActionErrorOnSuccess) {
		return state;
	}
	return advanceAdminBotFeedback(state, null);
}

// Publishes a refresh failure unless newer action feedback already owns the surface.
export function finishAdminBotRefreshFailure(
	state: AdminBotViewState,
	request: AdminBotRefreshRequest,
	message: string
): AdminBotViewState {
	if (!refreshMayMutateFeedback(state, request)) {
		return state;
	}
	if (state.error?.owner === ADMIN_BOT_ERROR_OWNER.Action) {
		return state;
	}
	return advanceAdminBotFeedback(state, {
		message,
		owner: ADMIN_BOT_ERROR_OWNER.Refresh
	});
}

function refreshMayMutateFeedback(
	state: AdminBotViewState,
	request: AdminBotRefreshRequest
): boolean {
	return (
		isCurrentAdminBotRefresh(state, request) && state.feedbackRevision === request.feedbackRevision
	);
}

function advanceAdminBotFeedback(
	state: AdminBotViewState,
	error: AdminBotErrorState | null
): AdminBotViewState {
	return {
		...state,
		feedbackRevision: state.feedbackRevision + 1,
		error
	};
}
