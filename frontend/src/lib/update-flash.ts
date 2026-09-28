export type UpdateFlashKey = string | number | null | undefined;
export const UPDATE_FLASH_MODE = {
	Persistent: 'persistent',
	Transient: 'transient'
} as const;

type UpdateFlashMode = (typeof UPDATE_FLASH_MODE)[keyof typeof UPDATE_FLASH_MODE];

type UpdateFlashOptions = {
	key: UpdateFlashKey;
	mode?: UpdateFlashMode;
	playOnMount?: boolean;
};

export type UpdateFlashInput = UpdateFlashKey | UpdateFlashOptions | null | undefined;

const UPDATE_FLASH_TIMING = {
	[UPDATE_FLASH_MODE.Persistent]: {
		duration: 540,
		easing: 'cubic-bezier(0.16, 1, 0.3, 1)'
	},
	[UPDATE_FLASH_MODE.Transient]: {
		duration: 760,
		easing: 'cubic-bezier(0.16, 1, 0.3, 1)'
	}
} as const;
const UPDATE_FLASH_KEYFRAMES = {
	[UPDATE_FLASH_MODE.Persistent]: [
		{ backgroundColor: 'var(--update-flash-peak-background)', offset: 0 },
		{ backgroundColor: 'var(--update-flash-peak-background)', offset: 0.12 },
		{ backgroundColor: 'var(--update-flash-rest-background)', offset: 1 }
	],
	[UPDATE_FLASH_MODE.Transient]: [
		{ backgroundColor: 'transparent', offset: 0 },
		{ backgroundColor: 'var(--update-flash-peak-background)', offset: 0.08 },
		{ backgroundColor: 'var(--update-flash-rest-background)', offset: 0.45 },
		{ backgroundColor: 'transparent', offset: 1 }
	]
} as const satisfies Record<UpdateFlashMode, Keyframe[]>;

type NormalizedUpdateFlashOptions = Required<UpdateFlashOptions>;

const EMPTY_UPDATE_FLASH_OPTIONS: NormalizedUpdateFlashOptions = {
	key: null,
	mode: UPDATE_FLASH_MODE.Persistent,
	playOnMount: false
};

function normalizeUpdateFlashInput(input: UpdateFlashInput): NormalizedUpdateFlashOptions {
	if (input && typeof input === 'object' && 'key' in input) {
		return {
			key: input.key,
			mode: input.mode ?? UPDATE_FLASH_MODE.Persistent,
			playOnMount: input.playOnMount ?? false
		};
	}
	return {
		...EMPTY_UPDATE_FLASH_OPTIONS,
		key: input
	};
}

function updateFlashKeyChanged(
	left: NormalizedUpdateFlashOptions,
	right: NormalizedUpdateFlashOptions
): boolean {
	return left.key !== right.key || left.mode !== right.mode;
}

function updateFlashTiming(mode: UpdateFlashMode): KeyframeAnimationOptions {
	return {
		...UPDATE_FLASH_TIMING[mode],
		fill: 'none'
	};
}

function updateFlashKeyframes(mode: UpdateFlashMode): Keyframe[] {
	return [...UPDATE_FLASH_KEYFRAMES[mode]];
}

// Replays the shared update flash when the supplied refresh key changes.
export function updateFlash(node: HTMLElement, input: UpdateFlashInput) {
	let current = normalizeUpdateFlashInput(input);
	let animation: Animation | null = null;

	function replay(options: NormalizedUpdateFlashOptions): void {
		if (options.key === null || options.key === undefined || typeof node.animate !== 'function') {
			return;
		}
		animation?.cancel();
		animation = node.animate(updateFlashKeyframes(options.mode), updateFlashTiming(options.mode));
	}

	if (current.playOnMount) {
		replay(current);
	}

	return {
		update(nextInput: UpdateFlashInput) {
			const next = normalizeUpdateFlashInput(nextInput);
			if (!updateFlashKeyChanged(current, next)) {
				current = next;
				return;
			}
			current = next;
			replay(next);
		},
		destroy() {
			animation?.cancel();
		}
	};
}
