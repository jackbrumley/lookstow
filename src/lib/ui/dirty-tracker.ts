/**
 * Whether someone has changed anything in a form, so closing it can ask first (from Midfield
 * Digital Labs' modal-dirty-tracker). It watches the real fields inside the form:
 *
 * - Each field's value is noted when it appears, and again when it is first focused.
 * - A field someone focuses, types in or changes is "touched".
 * - The form has unsaved changes when a touched field, still on screen, differs from where it
 *   started. Typing something and then undoing it counts as no change.
 *
 * Search boxes, hidden fields and anything inside `data-dirty-ignore` are skipped.
 */

const FIELDS = 'input, select, textarea';
const IGNORED_TYPES = new Set(['search', 'hidden', 'button', 'submit', 'reset', 'image']);

function tracked(el: unknown): el is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
	if (!(
		el instanceof HTMLInputElement ||
		el instanceof HTMLSelectElement ||
		el instanceof HTMLTextAreaElement
	)) {
		return false;
	}
	if (
		(!(el instanceof HTMLSelectElement) && el.readOnly) ||
		el.closest('[data-dirty-ignore]') !== null
	)
		return false;
	return !(el instanceof HTMLInputElement) || !IGNORED_TYPES.has(el.type);
}

function valueOf(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): string {
	if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
		return el.checked ? '1' : '0';
	}
	return el.value;
}

export interface DirtyTracker {
	/** Whether any touched field differs from where it started. */
	isDirty(): boolean;
	/** Stops watching. */
	stop(): void;
}

/** Starts watching the fields inside `root`. */
export function trackChanges(root: HTMLElement): DirtyTracker {
	const start = new WeakMap<Element, string>();
	const touched = new Set<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();

	const note = (el: Element): void => {
		if (tracked(el) && !start.has(el)) start.set(el, valueOf(el));
	};
	const scan = (node: Element): void => {
		note(node);
		node.querySelectorAll(FIELDS).forEach(note);
	};
	scan(root);
	const observer = new MutationObserver((records) => {
		for (const record of records) {
			record.addedNodes.forEach((node) => {
				if (node instanceof Element) scan(node);
			});
		}
	});
	observer.observe(root, { childList: true, subtree: true });

	// Focus comes before any change, so the value here is where the field started.
	const onFocus = (event: Event): void => {
		const el = event.target;
		if (!tracked(el)) return;
		if (!touched.has(el)) start.set(el, valueOf(el));
		touched.add(el);
	};
	const onChange = (event: Event): void => {
		const el = event.target;
		if (!tracked(el)) return;
		if (!start.has(el)) start.set(el, '');
		touched.add(el);
	};
	root.addEventListener('focusin', onFocus, true);
	root.addEventListener('input', onChange, true);
	root.addEventListener('change', onChange, true);

	return {
		isDirty() {
			for (const el of touched) {
				if (el.isConnected && valueOf(el) !== start.get(el)) return true;
			}
			return false;
		},
		stop() {
			observer.disconnect();
			root.removeEventListener('focusin', onFocus, true);
			root.removeEventListener('input', onChange, true);
			root.removeEventListener('change', onChange, true);
		}
	};
}
