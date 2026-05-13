const POINTER_FOCUS_RELEASE_SELECTOR =
	'button, input[type="checkbox"], input[type="radio"], [role="button"]';

// Releases pointer-activated controls so page hotkeys keep working after clicks.
export function installPointerFocusRelease(documentRef: Document = document): () => void {
	function onPointerUp(event: PointerEvent): void {
		if (!(event.target instanceof Element)) return;
		const targetControl = event.target.closest(POINTER_FOCUS_RELEASE_SELECTOR);
		if (!targetControl && !isReleasableActiveElement(documentRef.activeElement)) return;

		requestAnimationFrame(() => {
			const active = documentRef.activeElement;
			if (isReleasableActiveElement(active)) {
				active.blur();
			}
		});
	}

	documentRef.addEventListener('pointerup', onPointerUp, true);
	return () => documentRef.removeEventListener('pointerup', onPointerUp, true);
}

function isReleasableActiveElement(value: Element | null): value is HTMLElement {
	return value instanceof HTMLElement && value.matches(POINTER_FOCUS_RELEASE_SELECTOR);
}
