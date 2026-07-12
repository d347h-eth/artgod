import { isAdminBotActive, type AdminBotKind, type AdminBotRecord } from './ports';

// Owns the Admin bot actions that may overlap while a start request is waiting for approval.
export const ADMIN_BOT_ACTION_KIND = {
	Start: 'start',
	Stop: 'stop'
} as const;

export type AdminBotActionKind = (typeof ADMIN_BOT_ACTION_KIND)[keyof typeof ADMIN_BOT_ACTION_KIND];

// Identifies one start or stop request so a newer action can supersede its completion.
export type AdminBotActionRequest = Readonly<{
	action: AdminBotActionKind;
	botKind: AdminBotKind;
	generation: number;
}>;

// Tracks overlapping Admin bot requests without treating every bot action as globally busy.
export type AdminBotActionState = Readonly<{
	nextGeneration: number;
	currentGenerationByBot: Partial<Record<AdminBotKind, number>>;
	pendingStartByBot: Partial<Record<AdminBotKind, number>>;
	pendingStopByBot: Partial<Record<AdminBotKind, number>>;
}>;

// Creates the empty request state used when the Admin bot panel mounts.
export function createAdminBotActionState(): AdminBotActionState {
	return {
		nextGeneration: 0,
		currentGenerationByBot: {},
		pendingStartByBot: {},
		pendingStopByBot: {}
	};
}

// Reserves a start request unless that bot already has a lifecycle action in flight.
export function beginAdminBotStart(
	state: AdminBotActionState,
	botKind: AdminBotKind
): { state: AdminBotActionState; request: AdminBotActionRequest } | null {
	if (isAdminBotStartPending(state, botKind) || isAdminBotStopPending(state, botKind)) {
		return null;
	}
	return beginAdminBotAction(state, ADMIN_BOT_ACTION_KIND.Start, botKind);
}

// Reserves a stop request and supersedes any earlier start completion for the same bot.
export function beginAdminBotStop(
	state: AdminBotActionState,
	botKind: AdminBotKind
): { state: AdminBotActionState; request: AdminBotActionRequest } | null {
	if (isAdminBotStopPending(state, botKind)) {
		return null;
	}
	return beginAdminBotAction(state, ADMIN_BOT_ACTION_KIND.Stop, botKind);
}

// Reports whether a request still owns the visible result for its bot.
export function isCurrentAdminBotAction(
	state: AdminBotActionState,
	request: AdminBotActionRequest
): boolean {
	return state.currentGenerationByBot[request.botKind] === request.generation;
}

// Clears a finished request while preserving the generation that invalidates older completions.
export function finishAdminBotAction(
	state: AdminBotActionState,
	request: AdminBotActionRequest,
	options: { stopSucceeded?: boolean } = {}
): AdminBotActionState {
	const pendingStartByBot = { ...state.pendingStartByBot };
	const pendingStopByBot = { ...state.pendingStopByBot };

	if (
		request.action === ADMIN_BOT_ACTION_KIND.Start &&
		pendingStartByBot[request.botKind] === request.generation
	) {
		delete pendingStartByBot[request.botKind];
	}
	if (
		request.action === ADMIN_BOT_ACTION_KIND.Stop &&
		pendingStopByBot[request.botKind] === request.generation
	) {
		delete pendingStopByBot[request.botKind];
	}
	if (
		request.action === ADMIN_BOT_ACTION_KIND.Stop &&
		options.stopSucceeded === true &&
		isCurrentAdminBotAction(state, request)
	) {
		delete pendingStartByBot[request.botKind];
	}

	return {
		...state,
		pendingStartByBot,
		pendingStopByBot
	};
}

// Reports whether the bot still has a start request waiting for its terminal result.
export function isAdminBotStartPending(state: AdminBotActionState, botKind: AdminBotKind): boolean {
	return state.pendingStartByBot[botKind] !== undefined;
}

// Reports whether the bot is currently being stopped.
export function isAdminBotStopPending(state: AdminBotActionState, botKind: AdminBotKind): boolean {
	return state.pendingStopByBot[botKind] !== undefined;
}

// Reports whether either lifecycle request should keep setup controls locked.
export function isAdminBotLifecycleActionPending(
	state: AdminBotActionState,
	botKind: AdminBotKind
): boolean {
	return isAdminBotStartPending(state, botKind) || isAdminBotStopPending(state, botKind);
}

// Allows Stop for every active state and before the first start-state event arrives.
export function canStopAdminBot(
	state: AdminBotActionState,
	bot: Pick<AdminBotRecord, 'botKind' | 'state'>
): boolean {
	return isAdminBotActive(bot.state) || isAdminBotStartPending(state, bot.botKind);
}

function beginAdminBotAction(
	state: AdminBotActionState,
	action: AdminBotActionKind,
	botKind: AdminBotKind
): { state: AdminBotActionState; request: AdminBotActionRequest } {
	const generation = state.nextGeneration + 1;
	const request = { action, botKind, generation } as const;
	return {
		request,
		state: {
			nextGeneration: generation,
			currentGenerationByBot: {
				...state.currentGenerationByBot,
				[botKind]: generation
			},
			pendingStartByBot:
				action === ADMIN_BOT_ACTION_KIND.Start
					? { ...state.pendingStartByBot, [botKind]: generation }
					: state.pendingStartByBot,
			pendingStopByBot:
				action === ADMIN_BOT_ACTION_KIND.Stop
					? { ...state.pendingStopByBot, [botKind]: generation }
					: state.pendingStopByBot
		}
	};
}
