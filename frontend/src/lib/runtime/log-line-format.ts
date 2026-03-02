export type TokenizedLogLine = {
	tokens: string[];
	message: string;
};

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

export function createTokenizedLogLine(tokens: readonly string[], message: string): TokenizedLogLine {
	return {
		tokens: [...tokens],
		message
	};
}
