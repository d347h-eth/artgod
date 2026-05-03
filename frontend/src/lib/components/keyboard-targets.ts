export type KeyboardTextEntryTargetOptions = {
	allowCheckboxAndRadio?: boolean;
};

// Identifies focused elements where page-level hotkeys should not consume typed input.
export function isKeyboardTextEntryTarget(
	target: EventTarget | null,
	options: KeyboardTextEntryTargetOptions = {}
): boolean {
	const element = asElementLike(target);
	if (!element) return false;
	if (element.isContentEditable) return true;
	const tag = element.tagName.toLowerCase();
	if (tag === 'input') {
		if (options.allowCheckboxAndRadio && isCheckboxOrRadio(element.type)) return false;
		return true;
	}
	return tag === 'textarea' || tag === 'select';
}

function isCheckboxOrRadio(type: string | undefined): boolean {
	return type === 'checkbox' || type === 'radio';
}

function asElementLike(
	target: EventTarget | null
): { tagName: string; isContentEditable?: boolean; type?: string } | null {
	if (!target) return null;
	if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement) {
		return target as HTMLElement;
	}
	const candidate = target as { tagName?: unknown; isContentEditable?: boolean; type?: string };
	return typeof candidate.tagName === 'string'
		? (candidate as { tagName: string; isContentEditable?: boolean; type?: string })
		: null;
}
