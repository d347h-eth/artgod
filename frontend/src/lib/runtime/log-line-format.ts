export type TokenizedLogLine = {
	tokens: string[];
	message: string;
};

export function parseRuntimeLogLine(line: string): TokenizedLogLine {
	const parsedJsonLine = parseJsonLogLine(line);
	if (parsedJsonLine) {
		return parsedJsonLine;
	}
	return parseBracketPrefixedLine(line);
}

export function parseBracketPrefixedLine(line: string): TokenizedLogLine {
	const tokens: string[] = [];
	let remaining = line;
	for (;;) {
		const match = remaining.match(/^\[([^\]]+)\]\s*/);
		if (!match) {
			break;
		}
		tokens.push(match[1]);
		remaining = remaining.slice(match[0].length);
	}
	return {
		tokens,
		message: remaining.trimStart()
	};
}

export function createTokenizedLogLine(
	tokens: readonly string[],
	message: string
): TokenizedLogLine {
	return {
		tokens: [...tokens],
		message
	};
}

function parseJsonLogLine(line: string): TokenizedLogLine | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith('{')) {
		return null;
	}

	let payload: unknown;
	try {
		payload = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return null;
	}

	const record = payload as Record<string, unknown>;
	const tokens = [
		stringField(record, 't'),
		stringField(record, 'level'),
		stringField(record, 'component'),
		stringField(record, 'action'),
		stringField(record, 'stream')
	].filter((value): value is string => Boolean(value));
	const message =
		stringField(record, 'msg') ??
		stringField(record, 'message') ??
		stringField(record, 'line') ??
		trimmed;

	return {
		tokens,
		message
	};
}

function stringField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	if (typeof value !== 'string') {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}
