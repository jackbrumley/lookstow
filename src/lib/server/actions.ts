/** Helpers for form actions: the result shape the pages toast, and reading fields */
import { fail } from '@sveltejs/kit';

export function done(message: string): { ok: true; message: string } {
	return { ok: true, message };
}

export function refused(message: string, status = 400) {
	return fail(status, { ok: false, message });
}

export function field(data: FormData, name: string): string {
	const value = data.get(name);
	return typeof value === 'string' ? value.trim() : '';
}

export function checked(data: FormData, name: string): boolean {
	const value = data.get(name);
	return value === 'on' || value === 'true' || value === '1';
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
