import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../database/connection.ts';
import { settings } from '../../database/schema.ts';
import {
	effectiveBackupRoot,
	graphCredentials,
	readSchedule,
	readScope,
	saveClientSecret,
	saveConnectionIds,
	saveSchedule,
	saveScope,
	SettingsError,
	setPicked
} from './settings.ts';
import { SCHEDULE_DEFAULTS, SCOPE_DEFAULTS } from '../../../domain/settings.ts';

const KEY = Buffer.alloc(32, 7);
const TENANT = '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';
const CLIENT = '11111111-2222-3333-4444-555555555555';

describe('settings', () => {
	it('start from the defaults and say what is missing to sign in', () => {
		const db = openDatabase(':memory:');
		expect(readSchedule(db)).toEqual(SCHEDULE_DEFAULTS);
		expect(graphCredentials(db, KEY)).toEqual({
			missing: expect.stringMatching(/tenant ID/) as unknown
		});
		saveConnectionIds(db, TENANT, CLIENT);
		expect(graphCredentials(db, KEY)).toEqual({
			missing: expect.stringMatching(/certificate/) as unknown
		});
	});

	it('store a client secret sealed, never as text', () => {
		const db = openDatabase(':memory:');
		saveConnectionIds(db, TENANT, CLIENT);
		saveClientSecret(db, 'abc~a-very-secret-client-value', KEY);
		const stored = db
			.select()
			.from(settings)
			.all()
			.map((row) => row.value)
			.join('');
		expect(stored).not.toContain('a-very-secret-client-value');
		expect(graphCredentials(db, KEY)).toEqual({
			credentials: {
				tenantId: TENANT,
				clientId: CLIENT,
				auth: { kind: 'secret', secret: 'abc~a-very-secret-client-value' }
			}
		});
	});

	it('refuse IDs that are not GUIDs and schedules out of range', () => {
		const db = openDatabase(':memory:');
		expect(() => {
			saveConnectionIds(db, 'contoso.onmicrosoft.com', CLIENT);
		}).toThrow();
		expect(() => {
			saveSchedule(db, { ...SCHEDULE_DEFAULTS, syncEveryMinutes: 1 });
		}).toThrow(SettingsError);
	});

	it('keep excluded addresses lower case, sorted and once each', () => {
		const db = openDatabase(':memory:');
		saveScope(db, {
			...SCOPE_DEFAULTS,
			excludedAddresses: ['B@x.com', 'a@x.com', 'b@x.com']
		});
		expect(readScope(db).excludedAddresses).toEqual(['a@x.com', 'b@x.com']);
	});

	it('load a scope saved by 0.1.0, before picking existed, as every mailbox', () => {
		const db = openDatabase(':memory:');
		db.insert(settings)
			.values({
				key: 'scope',
				value:
					'{"includeShared":true,"includeResources":false,"includeArchives":true,"excludedAddresses":[]}',
				updatedAt: new Date()
			})
			.run();
		expect(readScope(db)).toMatchObject({ mode: 'all', selectedAddresses: [] });
	});

	it('pick and unpick mailboxes one at a time', () => {
		const db = openDatabase(':memory:');
		saveScope(db, { ...SCOPE_DEFAULTS, mode: 'selected' });
		setPicked(db, 'Ann@Example.com', true);
		setPicked(db, 'bob@example.com', true);
		setPicked(db, 'ann@example.com', false);
		expect(readScope(db).selectedAddresses).toEqual(['bob@example.com']);
	});

	it('put backups beside the database unless a folder is chosen', () => {
		const db = openDatabase(':memory:');
		expect(effectiveBackupRoot(db, '/var/lib/lookstow')).toMatch(/mailboxes$/);
	});

	it('fail loudly on a stored value that no longer validates', () => {
		const db = openDatabase(':memory:');
		db.insert(settings)
			.values({ key: 'schedule', value: '{"syncEveryMinutes":"often"}', updatedAt: new Date() })
			.run();
		expect(() => readSchedule(db)).toThrow(/Save it again/);
	});
});
