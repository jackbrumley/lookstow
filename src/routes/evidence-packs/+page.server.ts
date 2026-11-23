import { error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { checked, done, field, refused } from '#lib/server/actions.ts';
import { aiTools, database, dataDir } from '#lib/server/runtime.ts';
import { recordActivity } from '#lib/server/services/activity/activity.ts';
import {
	createPack,
	listPacks,
	planPack,
	readPack,
	removePack,
	requeuePack
} from '#lib/server/services/evidence/packs.ts';
import { messageIdsIn, packName } from '#lib/domain/evidence-packs.ts';

/**
 * Evidence packs (docs/specs/SPEC-EVIDENCE-PACKS.md): paste message ids, check them, and make
 * one ZIP of those messages to hand to a lawyer; then download it. On this computer, and for
 * remote accounts given the right (the gate lets nobody else here).
 */
const MISSING_SHOWN = 200;

function who(locals: App.Locals): string {
	return locals.isLocal ? 'console' : (locals.remoteUser ?? 'remote');
}

export const load = (async ({ locals }) => {
	const { packs, removed } = await listPacks(dataDir());
	for (const pack of removed) {
		recordActivity(database, {
			level: 'info',
			kind: 'evidence-pack',
			actor: 'lookstow',
			summary: `Evidence pack removed after its keeping time: ${pack.name}`
		});
	}
	return { packs, me: who(locals), isLocal: locals.isLocal };
}) satisfies PageServerLoad;

async function plan(data: FormData) {
	const { ids, repeats } = messageIdsIn(field(data, 'ids'));
	const withAttachments = checked(data, 'withAttachments');
	return {
		withAttachments,
		plan: await planPack(database, dataDir(), ids, repeats, withAttachments)
	};
}

async function ownPack(locals: App.Locals, id: string) {
	const pack = await readPack(dataDir(), id).catch(() => null);
	if (pack === null) error(404, 'No such evidence pack');
	// A remote person changes only the packs they asked for.
	if (!locals.isLocal && pack.createdBy !== locals.remoteUser) {
		error(403, 'Only the person who asked for this pack, or the server itself, can change it.');
	}
	return pack;
}

export const actions = {
	check: async ({ request }) => {
		const data = await request.formData();
		const { plan: checkedPlan } = await plan(data);
		return {
			ok: checkedPlan.refusal === null,
			message:
				checkedPlan.refusal ??
				`${String(checkedPlan.found.length)} messages found${checkedPlan.missing.length > 0 ? `, ${String(checkedPlan.missing.length)} not in the backup` : ''}.`,
			preview: {
				found: checkedPlan.found.length,
				missing: checkedPlan.missing.slice(0, MISSING_SHOWN),
				missingCount: checkedPlan.missing.length,
				repeats: checkedPlan.repeats,
				sourceBytes: checkedPlan.sourceBytes,
				freeBytes: checkedPlan.freeBytes,
				refusal: checkedPlan.refusal
			}
		};
	},
	build: async ({ request, locals }) => {
		const data = await request.formData();
		const { plan: buildPlan, withAttachments } = await plan(data);
		if (buildPlan.refusal !== null) return refused(buildPlan.refusal);
		const name = packName(field(data, 'name'), new Date());
		const pack = await createPack(dataDir(), buildPlan, {
			name,
			createdBy: who(locals),
			withAttachments
		});
		recordActivity(database, {
			level: 'info',
			kind: 'evidence-pack',
			actor: who(locals),
			summary: `Evidence pack asked for: ${pack.name}`,
			detail: `${String(pack.total)} messages${pack.missing.length > 0 ? `; ${String(pack.missing.length)} ids not in the backup` : ''}.`
		});
		await aiTools().buildPack(pack.id);
		return done(`Making “${pack.name}” (${String(pack.total)} messages). It shows below.`);
	},
	again: async ({ request, locals }) => {
		const data = await request.formData();
		const pack = await ownPack(locals, field(data, 'id'));
		if (pack.status !== 'failed') return refused('Only a failed pack can be made again.');
		await requeuePack(dataDir(), pack);
		await aiTools().buildPack(pack.id);
		return done(`Making “${pack.name}” again.`);
	},
	remove: async ({ request, locals }) => {
		const data = await request.formData();
		const stored = await ownPack(locals, field(data, 'id'));
		const { packs } = await listPacks(dataDir());
		const pack = packs.find((each) => each.id === stored.id) ?? stored;
		await removePack(dataDir(), pack);
		recordActivity(database, {
			level: 'info',
			kind: 'evidence-pack',
			actor: who(locals),
			summary: `Evidence pack removed: ${pack.name}`
		});
		return done(
			pack.status === 'building' || pack.status === 'queued'
				? `Stopping “${pack.name}”; it is removed in a moment.`
				: `Removed “${pack.name}”.`
		);
	}
} satisfies Actions;
