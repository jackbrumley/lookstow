import { describe, expect, it } from 'vitest';
import { isMailFolderClass } from '../graph/archive.ts';
import { countsFor } from './sync-common.ts';

describe('which folders the completeness check compares', () => {
	it('archive folders are compared only when they hold mail', () => {
		expect(isMailFolderClass('IPF.Note')).toBe(true);
		expect(isMailFolderClass('IPF.Note.OutlookHomepage')).toBe(true);
		expect(isMailFolderClass(null)).toBe(true);
		expect(isMailFolderClass('IPF.Contact')).toBe(false);
		expect(isMailFolderClass('IPF.Appointment')).toBe(false);
		expect(isMailFolderClass('IPF.Notes')).toBe(false);
	});

	it('a folder not compared gets no count, which clears its old one; one without a count is left', () => {
		const synced = [
			{ id: 'f-inbox', graphId: 'inbox' },
			{ id: 'f-meta', graphId: 'meta' },
			{ id: 'f-quiet', graphId: 'quiet' },
			{ id: 'f-gone', graphId: 'gone' }
		];
		const after = [
			{ graphId: 'inbox', totalItemCount: 5, compared: true },
			{ graphId: 'meta', totalItemCount: 2926, compared: false },
			{ graphId: 'quiet', totalItemCount: null, compared: true }
		];
		expect(countsFor(synced, after, new Map([['f-inbox', 4]]))).toEqual([
			{ folderId: 'f-inbox', count: 5, listed: 4 },
			{ folderId: 'f-meta', count: null, listed: null }
		]);
	});
});
