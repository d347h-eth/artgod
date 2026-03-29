export const DEFAULT_LOADING_BLADE_BAR_LENGTH = 20;
export const DEFAULT_LOADING_BLADE_BAR_TICK_MS = 15;

export const LOADING_BLADE_BAR_BLADES = [
	'███████░░████████░░███████    █',
	'▟▙▆▇▂▟▙▆▇▂▟▙▆▇▂▟▙▆▇▂▟▙▆▇▂           ▅█▃▊▄▜▛▁',
	'▟ █ █ █ █ █ ▙ ▆▇░░░░░░░░░░░░▒▒▒▒▒▒▒▒▒▓▓▓▙――――――▄▄▄▀▀▀▄▄▄▀▀▀▄▄▄▀▀▀▄▄▄▀▀▀▄▄▄▀▀▀▄▄▄▀▀▀▜▁▛▜▁▛ ',
	'   ░░░░░░▒▒▒▒▒▒▒▓▓▓▓▓▓▓▓███████▓▓▓▓▓▓▓▓▓▒▒▒▒▒░░░░░',
	'▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▓░░▂▃▅▅▃▂░░▓▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▓░░░░▓▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▓░░░░▓▰▰▰▰▰▰▰▓▓▓▓▓▓░░░░▓▓▓▓▓▓▓▓▓▓▓',
	'▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▄▄▄▄▄░░░░░▓▓▓▓████░░░░░░░░░░░░░░░░░░░',
	'――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――▇▇▇▇▇▆▇▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂',
	'||||||||||||||||||||||||||||||||||||||||||||||||||░░▒▒▒▒▒▒▒▓▓▓▓▓▓▓▓███ ███▓▓▓',
	'░░░▒▒▒――++++―++++░░░▓++―▓█――+█++++―▒▒▒░░░ █▰▰▰     ░    ░   ░      ░  █   ░  █   ░    ',
	'――――――――――――▂▃░░▓▓▓▓▓▓▓▓▓▒▒░░▃▂▂▂▂▂▂▂▂▂▂▂',
	'+++++▓▓++++++++++++++++++++++++++▓▓▓▓+++++++++▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓',
	'▂▃▅▅▃▂▟███████████████████████████████████▙▂▃▅▅▃▂',
	'▄▄▄▄▆▆▆██░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▄▌▌▌▌▄▄▄▄░░░░░▓▓▓▓████',
	'▓▓▓▓▓▓░░░░░░██████████+█████████████████+████████▓▓▓▓▓▓░░░░░░',
	'▂▃▅▅▃▂▂                    ▂▂▂▂▟████████████████████████████████████████████████▙',
	'█▌▐▄▀░▒░▒░▒░▒░▒░▒░▒░▒░▒░▒░░▒▒▒░░░░░░░░░░▒▒▒▒▓▓▓▓▓▓▓▓▒▒▒▒░░░░░▒░▒░▒░▒░▒░▓▓▓▓▓▓▓▓▒░▒░▒░▒░▒░▒░▒░▒░▒░▒▓▓',
	'█▌█▌█▌█▌█▌█▌█▌█▌▐▐▐▐▐▐▐▐▐▐▐▐▐▐▐ ▐――▐――▐――▐――▐――▐――▐――▐――▐――▐――▐―――――――――――――▓▓▓▓▓▓▓▓▓▓',
	'▓▓▓▓+░░░░░░░░░░▓▓▓▓+░░░░░░░░░░▓▓▓▓+▓▓+▓▓+▓▓+░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓░░░░░░░░░░░░░░░░',
	'░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▒▒▒▓▓▓░░░▒▒▒▓▓▓░░░████████████    █    ████████████▒▒▒▓▓▓░░░▒▒▒▓▓▓░░░▒▒▒▓▓▓░░░▒▒▒▓▓▓',
	'▆▇ ▆▇ ▆░░▇ ▆▇ ▆ ▇ ▆ ▇░░░░―░―░―░―░―░░░░▆▇ ▆ ▇░░▆▇▆ ▇▆▇▆▇   ―    ―    ―  ░―░―░░░░',
	'▓▓▓▓▓▓░░░░░░▓▓▓▓▓▓░░░░░░▓▓▓▓▓▓░░░░░░―――░▓░▓░▓░▓░▓░▓░▓░▓░▓░▓░▓░▓░▓░▓░▓░▓░▓░▓░▓░▓░▓░▓░▓░▓',
	'▒▓█    ▒▓█   ▒▓██   ▒▓██ ▒▓██  ▒▓█  ██████    █    █████▒▒▒▓▓▓░░░▒▒▒▓▓▓░░░▒▒▒▓▓▓░░░▒▒▒▓▓▓',
	'█▌▁▁▁▟▙▟▙▟▙▟▙▟▙▟▙▁▁▐▄▀▐▄▀▐▄▀▐▄▀▐▄▀▄▀░▒▓▓',
	'░░░▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰',
	'█▌█▌█▌█▌█▌█▌█▌█▌▐▐▐▐▐▐▐▐▐▐▐▐▐▐▐ ――――――――――――▓▓▓▓▓▓▓▓▓▓',
	'   ███████    █    █  █    ▓▓  ▓▓  ▓▓',
	'||░░++▓▓――▆▇'
] as const;

export function pickRandomLoadingBlade(random: () => number = Math.random): string {
	const rawIndex = Math.floor(random() * LOADING_BLADE_BAR_BLADES.length);
	const index = Math.min(LOADING_BLADE_BAR_BLADES.length - 1, Math.max(0, rawIndex));
	return LOADING_BLADE_BAR_BLADES[index] ?? 'loading';
}

export function buildLoadingBladeRail(blade: string, barLength: number): string[] {
	const normalizedLength = Math.max(1, Math.floor(barLength));
	const glyphs = Array.from(blade);
	if (glyphs.length === 0) {
		return Array.from({ length: normalizedLength }, () => ' ');
	}
	if (glyphs.length >= normalizedLength) {
		return glyphs;
	}
	return [...glyphs, ...Array.from({ length: normalizedLength - glyphs.length }, () => ' ')];
}

export function renderLoadingBladeBarFrame(params: {
	rail: string[];
	barLength: number;
	offset: number;
}): string {
	const length = Math.max(1, Math.floor(params.barLength));
	const rail = params.rail.length > 0 ? params.rail : Array.from({ length }, () => ' ');
	const offset = ((Math.floor(params.offset) % rail.length) + rail.length) % rail.length;
	const frame: string[] = [];
	for (let index = 0; index < length; index += 1) {
		frame.push(rail[(offset + index) % rail.length] ?? ' ');
	}
	return frame.join('');
}
